// Starts the relay server (port 8080) and the Vite dev server (port 5173) together.
import { spawn } from 'node:child_process';

const procs = [
  spawn('npm', ['run', 'dev', '-w', '@mini/server'], { stdio: 'inherit', shell: true }),
  spawn('npm', ['run', 'dev', '-w', '@mini/client', '--', '--host'], { stdio: 'inherit', shell: true }),
];

const stop = () => {
  for (const p of procs) p.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => code && stop());
