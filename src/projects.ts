import { writeFile, readFile, mkdir } from 'fs/promises';
import { resolve, join } from 'path';
import { existsSync } from 'fs';
import os from 'os';

const CONFIG_DIR = join(os.homedir(), '.veepee-code');
const PROJECTS_FILE = join(CONFIG_DIR, 'projects.json');

export interface ProjectEntry {
  cwd: string;
  sessionId: string;
  sessionName: string;
  lastUsed: string; // ISO date
}

async function loadProjects(): Promise<ProjectEntry[]> {
  if (!existsSync(PROJECTS_FILE)) return [];
  try {
    const data = await readFile(PROJECTS_FILE, 'utf-8');
    return JSON.parse(data) as ProjectEntry[];
  } catch {
    return [];
  }
}

async function saveProjects(entries: ProjectEntry[]): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  const tmp = PROJECTS_FILE + '.tmp';
  await writeFile(tmp, JSON.stringify(entries, null, 2));
  const { rename } = await import('fs/promises');
  await rename(tmp, PROJECTS_FILE);
}

/** Get the saved session for the given working directory, or null if none */
export async function getProjectSession(cwd: string): Promise<ProjectEntry | null> {
  const entries = await loadProjects();
  return entries.find(e => e.cwd === resolve(cwd)) ?? null;
}

/** Record or update the session for a working directory */
export async function setProjectSession(
  cwd: string,
  sessionId: string,
  sessionName: string,
): Promise<void> {
  const entries = await loadProjects();
  const resolvedCwd = resolve(cwd);
  const idx = entries.findIndex(e => e.cwd === resolvedCwd);
  const entry: ProjectEntry = {
    cwd: resolvedCwd,
    sessionId,
    sessionName,
    lastUsed: new Date().toISOString(),
  };
  if (idx >= 0) {
    entries[idx] = entry;
  } else {
    entries.push(entry);
  }
  await saveProjects(entries);
}

/** List all tracked projects, newest first */
export async function listProjects(): Promise<ProjectEntry[]> {
  const entries = await loadProjects();
  return entries.sort((a, b) => b.lastUsed.localeCompare(a.lastUsed));
}

/** Format project list for display */
export function formatProjectList(entries: ProjectEntry[]): string {
  if (entries.length === 0) {
    return '  No tracked projects. Save a session with /save to start tracking.';
  }

  const lines = ['', '  Projects (cwd → last session)', ''];
  for (const e of entries) {
    const age = formatAge(e.lastUsed);
    lines.push(`  ${e.cwd.padEnd(40)} ${age.padEnd(6)} ${e.sessionName}`);
    lines.push(`  ${' '.repeat(40)} ID: ${e.sessionId}`);
    lines.push('');
  }
  lines.push(`  ${entries.length} project(s) | /resume <name> to open a session`);
  lines.push('');
  return lines.join('\n');
}

function formatAge(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}
