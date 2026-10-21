import { writeSync } from 'node:fs';

// The inherited writer keeps the supervisor's channel alive even if our
// coordinator dies before this first instruction. Nothing runs before ACK.
writeSync(3, JSON.stringify({ type: 'register', pid: process.pid }) + '\n');
let input = '';
let released = false;
process.stdin.on('data', (chunk) => {
  input += chunk.toString();
  const end = input.indexOf('\n');
  if (end < 0 || released) return;
  released = true;
  const { executable, args, env } = JSON.parse(input.slice(0, end));
  // execve preserves this already-registered PID/PG and closes nonstandard FDs.
  // It does not create another detached child or a registration race.
  process.execve(executable, [executable, ...args], Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === 'string')));
});
process.stdin.on('end', () => { if (!released) process.exit(125); });
process.stdin.on('error', () => process.exit(125));
