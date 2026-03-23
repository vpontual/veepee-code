import { execSync, execFileSync } from 'child_process';
import { z } from 'zod';
import type { ToolDef } from './types.js';
import { ok, fail } from './types.js';

export function registerDevOpsTools(): ToolDef[] {
  return [
    createDockerTool(),
    createSystemInfoTool(),
  ];
}

function createDockerTool(): ToolDef {
  return {
    name: 'docker',
    description: 'Run Docker commands: ps, logs, exec, build, compose, images, volumes, networks, etc. Use for container management.',
    schema: z.object({
      args: z.string().describe('Docker arguments (e.g. "ps -a", "logs mycontainer --tail 50", "compose up -d")'),
      cwd: z.string().optional().describe('Working directory for docker compose commands'),
    }),
    execute: async (params) => {
      try {
        const args = params.args as string;
        const cwd = (params.cwd as string) || process.cwd();

        // Parse args string into array for execFileSync (prevents shell injection)
        const parsedArgs = args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map(a =>
          a.replace(/^["']|["']$/g, '')
        ) || [];

        const output = execFileSync('docker', parsedArgs, {
          cwd,
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024,
          timeout: 60000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        return ok(output.trim() || '(no output)');
      } catch (err) {
        const error = err as { stderr?: string; message?: string };
        return fail(error.stderr?.trim() || error.message || 'Docker command failed');
      }
    },
  };
}

function createSystemInfoTool(): ToolDef {
  return {
    name: 'system_info',
    description: 'Get system information: OS, CPU, memory, disk usage, network, running processes. Use to check system resources.',
    schema: z.object({
      query: z.enum(['overview', 'memory', 'disk', 'cpu', 'network', 'processes']).describe('What information to retrieve'),
    }),
    execute: async (params) => {
      try {
        const query = params.query as string;
        let output = '';

        switch (query) {
          case 'overview':
            output = execSync('uname -a && echo "---" && sw_vers 2>/dev/null || cat /etc/os-release 2>/dev/null || true', {
              encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
            });
            break;

          case 'memory':
            if (process.platform === 'darwin') {
              const vm = execSync('vm_stat', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
              const sysctl = execSync('sysctl hw.memsize', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
              output = `${sysctl}\n${vm}`;
            } else {
              output = execSync('free -h', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
            }
            break;

          case 'disk':
            output = execSync('df -h', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
            break;

          case 'cpu':
            if (process.platform === 'darwin') {
              output = execSync('sysctl -n machdep.cpu.brand_string && echo "Cores: $(sysctl -n hw.ncpu)" && top -l 1 -n 0 | head -10', {
                encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
              });
            } else {
              output = execSync('lscpu | head -20 && echo "---" && uptime', {
                encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
              });
            }
            break;

          case 'network':
            output = execSync('ifconfig 2>/dev/null || ip addr 2>/dev/null', {
              encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
            });
            break;

          case 'processes':
            output = execSync('ps aux --sort=-%mem 2>/dev/null | head -20 || ps aux | head -20', {
              encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
            });
            break;
        }

        return ok(output.trim());
      } catch (err) {
        return fail(`System info failed: ${(err as Error).message}`);
      }
    },
  };
}
