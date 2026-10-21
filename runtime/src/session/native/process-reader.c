/* Fixed, non-privileged macOS process snapshot. No arguments, signals or exec.
 * Command arguments are hashed in place; neither arguments nor environment
 * values are emitted. Unknown identities remain visible, never signalable. */
#define COMMON_DIGEST_FOR_OPENSSL
#include <CommonCrypto/CommonDigest.h>
#include <errno.h>
#include <inttypes.h>
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc.h>
#include <sys/sysctl.h>
#include <unistd.h>

static void hex_digest(const void *bytes, size_t size, char output[65]) {
    unsigned char hash[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(bytes, (CC_LONG)size, hash);
    for (size_t i = 0; i < sizeof(hash); i++) snprintf(output + i * 2, 3, "%02x", hash[i]);
}

static int process_info(pid_t pid, struct proc_bsdinfo *info) {
    /* KERN_PROC_PID exposes basic identity across users without the privileged
     * PROC_PIDTBSDINFO read. Unreadable arguments still remain unqualified. */
    struct kinfo_proc value = {0};
    int mib[] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid};
    size_t size = sizeof(value);
    if (sysctl(mib, 4, &value, &size, NULL, 0) || size != sizeof(value)) return 0;
    info->pbi_pid = (uint32_t)value.kp_proc.p_pid;
    info->pbi_ppid = (uint32_t)value.kp_eproc.e_ppid;
    info->pbi_pgid = (uint32_t)value.kp_eproc.e_pgid;
    info->pbi_uid = value.kp_eproc.e_ucred.cr_uid;
    info->pbi_status = (uint32_t)value.kp_proc.p_stat;
    info->pbi_start_tvsec = (uint64_t)value.kp_proc.p_starttime.tv_sec;
    info->pbi_start_tvusec = (uint64_t)value.kp_proc.p_starttime.tv_usec;
    return 1;
}

static int argument_hashes(pid_t pid, char *buffer, size_t maximum, char command[65], char last[65]) {
    int mib[] = {CTL_KERN, KERN_PROCARGS2, pid}, argc = 0, valid = 0;
    size_t size = (size_t)maximum;
    if (sysctl(mib, 3, buffer, &size, NULL, 0) || size < sizeof(argc)) goto done;
    memcpy(&argc, buffer, sizeof(argc));
    if (argc < 1 || (size_t)argc > maximum) goto done;
    char *end = buffer + size, *cursor = buffer + sizeof(argc);
    char *nul = memchr(cursor, 0, (size_t)(end - cursor));
    if (!nul) goto done;
    cursor = nul + 1; /* executable path is followed by alignment padding */
    while (cursor < end && *cursor == 0) cursor++;
    char *first = cursor, *final = NULL;
    size_t final_size = 0;
    for (int index = 0; index < argc; index++) {
        if (cursor >= end || !(nul = memchr(cursor, 0, (size_t)(end - cursor)))) goto done;
        final = cursor; final_size = (size_t)(nul - cursor); cursor = nul + 1;
    }
    /* Stop at argc. Bytes after this point can contain the environment. */
    hex_digest(first, (size_t)(cursor - first), command);
    hex_digest(final, final_size, last);
    valid = 1;
done:
    return valid;
}

int main(int argc, char **argv) {
    (void)argv;
    if (argc != 1) { fputs("process-reader accepts no arguments\n", stderr); return 64; }
    int capacity = proc_listallpids(NULL, 0) + 1024, count = 0;
    pid_t *pids = NULL;
    for (int attempt = 0; attempt < 4; attempt++) {
        if (capacity < 1 || capacity > 262144) return 1;
        free(pids); pids = calloc((size_t)capacity, sizeof(pid_t));
        if (!pids) return 1;
        count = proc_listallpids(pids, capacity * (int)sizeof(pid_t));
        if (count <= 0) { free(pids); return 1; }
        if (count < capacity) break;
        if (attempt == 3) { free(pids); return 1; }
        capacity *= 2;
    }
    if (count >= capacity) { free(pids); return 1; }
    int maximum = 0, maximum_mib[] = {CTL_KERN, KERN_ARGMAX};
    size_t maximum_size = sizeof(maximum);
    if (sysctl(maximum_mib, 2, &maximum, &maximum_size, NULL, 0) || maximum < 1 || maximum > 16 * 1024 * 1024) { free(pids); return 1; }
    char *buffer = calloc(1, (size_t)maximum);
    if (!buffer) { free(pids); return 1; }
    printf("{\"schemaVersion\":1,\"processes\":[");
    int comma = 0;
    for (int index = 0; index < count; index++) {
        pid_t pid = pids[index];
        if (pid <= 0) continue;
        struct proc_bsdinfo before = {0}, after = {0};
        if (!process_info(pid, &before)) {
            /* An exited process is absent. An unreadable survivor is retained
             * with its group where obtainable, so it cannot vanish from custody. */
            errno = 0; pid_t pgid = getpgid(pid);
            if (pgid < 0 && errno == ESRCH) continue;
            printf("%s{\"pid\":%d,\"ppid\":0,\"pgid\":%d,\"uid\":-1,\"state\":\"?\",\"startedAt\":\"\",\"commandSha256\":\"\",\"lastArgumentSha256\":\"\"}", comma++ ? "," : "", pid, pgid);
            continue;
        }
        char command[65] = "", last[65] = "";
        argument_hashes(pid, buffer, (size_t)maximum, command, last);
        /* Do not combine arguments and identity from different PID occupants. */
        if (!process_info(pid, &after)) {
            errno = 0; pid_t pgid = getpgid(pid);
            if (pgid < 0 && errno == ESRCH) continue;
            printf("%s{\"pid\":%d,\"ppid\":0,\"pgid\":%d,\"uid\":-1,\"state\":\"?\",\"startedAt\":\"\",\"commandSha256\":\"\",\"lastArgumentSha256\":\"\"}", comma++ ? "," : "", pid, pgid);
            continue;
        }
        if (before.pbi_start_tvsec != after.pbi_start_tvsec || before.pbi_start_tvusec != after.pbi_start_tvusec || before.pbi_pgid != after.pbi_pgid) { command[0] = 0; last[0] = 0; }
        printf("%s{\"pid\":%u,\"ppid\":%u,\"pgid\":%u,\"uid\":%u,\"state\":\"%s\",\"startedAt\":\"%" PRIu64 ":%" PRIu64 "\",\"commandSha256\":\"%s\",\"lastArgumentSha256\":\"%s\"}", comma++ ? "," : "", after.pbi_pid, after.pbi_ppid, after.pbi_pgid, after.pbi_uid, after.pbi_status == SZOMB ? "Z" : "A", after.pbi_start_tvsec, after.pbi_start_tvusec, command, last);
    }
    free(pids);
    for (volatile char *wipe = buffer; wipe < buffer + maximum; wipe++) *wipe = 0;
    free(buffer);
    puts("]}");
    return ferror(stdout) ? 1 : 0;
}
