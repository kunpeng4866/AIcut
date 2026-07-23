// Launch script — clears ELECTRON_RUN_AS_NODE and starts Electron
const { spawn } = require('child_process');
const { join } = require('path');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const electronBin = join(__dirname, 'node_modules', 'electron', 'dist', 'electron.exe');
const extraArgs = process.argv.slice(2);
const child = spawn(electronBin, ['.', ...extraArgs], {
  stdio: 'inherit',
  cwd: __dirname,
  env,
});

child.on('close', (code) => process.exit(code));
