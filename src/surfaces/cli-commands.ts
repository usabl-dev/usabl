/**
 * The CLI command table: every command, what it does, and every flag it takes.
 * Help text and the check that refuses an unknown flag both read this table, so a command or flag
 * the table does not describe cannot be run, and help cannot fall behind the parser.
 * This module formats text only. It must never run a check or decide a verdict.
 */
import { neutralize } from '../primitives/neutralize.js';
import { parseCliArgs } from './cli.js';

export interface CliFlag {
  name: string;
  // The placeholder for the value the flag takes, when it takes one.
  value?: string;
  help: string;
}

export interface CliCommand {
  name: string;
  usage: string;
  summary: string;
  flags: readonly CliFlag[];
}

export const HELP_FLAGS: readonly string[] = ['--help', '-h'];

const CONFIG_FLAG: CliFlag = {
  name: '--config',
  value: '<path>',
  help: 'Read the config from this file. Default: usabl.config.json.',
};

const TRUSTED_REF_FLAG: CliFlag = {
  name: '--trusted-ref',
  value: '<git-ref>',
  help: 'Read policy files from this git ref, not from the working tree.',
};

const STATIC_ONLY_FLAG: CliFlag = {
  name: '--static-only',
  help: 'Run no live browser checks. Each one is reported as a gap.',
};

export const CLI_COMMANDS: readonly CliCommand[] = [
  {
    name: 'check',
    usage: 'usabl check [options]',
    summary: 'Check the screens your change touches and print the verdict.',
    flags: [
      { name: '--json', help: 'Print the full result as JSON instead of text.' },
      { name: '--self-check', help: 'Print an advisory result that always exits 0.' },
      STATIC_ONLY_FLAG,
      {
        name: '--trusted-ref',
        value: '<git-ref>',
        help: 'Read policy from this git ref and check the files changed since it.',
      },
      { name: '--ci', help: 'Run as the CI gate. Needs --trusted-ref.' },
      CONFIG_FLAG,
    ],
  },
  {
    name: 'init',
    usage: 'usabl init [options]',
    summary: 'Draft usabl.config.json and usabl.routes.json from your code.',
    flags: [
      { name: '--docs', help: 'Draft usabl.docs.json for a docs repository instead.' },
      { name: '--force', help: 'Replace draft files that already exist.' },
      { name: '--app', value: '<dir>', help: 'Draft one app folder of a monorepo, such as packages/web.' },
    ],
  },
  {
    name: 'baseline',
    usage: 'usabl baseline [options]',
    summary: 'Scan every mapped screen twice and draft .usabl-evidence.json.',
    flags: [
      {
        name: '--partial',
        help: 'Record only the screens that scanned cleanly instead of refusing on gaps.',
      },
      TRUSTED_REF_FLAG,
      CONFIG_FLAG,
    ],
  },
  {
    name: 'session',
    usage: 'usabl session [options]',
    summary: 'Sign in once in a browser and save the session scans use.',
    flags: [CONFIG_FLAG],
  },
  {
    name: 'floor',
    usage: 'usabl floor prune [options]',
    summary: 'Lower or remove floor entries for accessibility barriers now gone.',
    flags: [
      {
        name: '--unconfirmed',
        help: 'Also remove absent entries this run cannot confirm were fixed.',
      },
      TRUSTED_REF_FLAG,
      CONFIG_FLAG,
    ],
  },
  {
    name: 'drift',
    usage: 'usabl drift routes [options]',
    summary: 'Compare usabl.routes.json with the routes in the app router.',
    flags: [CONFIG_FLAG],
  },
  {
    name: 'doctor',
    usage: 'usabl doctor [options]',
    summary: 'Report what is set up and what is missing. Writes nothing.',
    flags: [CONFIG_FLAG],
  },
  {
    name: 'install',
    usage: 'usabl install <one target flag> [options]',
    summary: 'Set up one integration. Name exactly one target flag.',
    flags: [
      { name: '--overlay', help: 'Target: the browser overlay in the Vite dev server.' },
      { name: '--claude', help: 'Target: the Claude Code Stop hook.' },
      { name: '--claude-skill', help: 'Target: the /usabl-check and /usabl-fix skills.' },
      { name: '--cursor', help: 'Target: the Cursor stop hook, command, and rule.' },
      { name: '--ci', help: 'Target: the pull request gate for GitHub Actions.' },
      { name: '--docs-ci', help: 'Target: the docs gate for GitHub Actions.' },
      {
        name: '--branch-rule',
        help: 'Target: confirm the branch rule requires the usabl checks. Writes nothing.',
      },
      {
        name: '--config',
        value: '<path>',
        help: 'Read uiFileGlobs for the Cursor rule from this config file.',
      },
    ],
  },
  {
    name: 'docs',
    usage: 'usabl docs [options]',
    summary: 'Print the design intake and transcript artifacts of a run as JSON.',
    flags: [
      { name: '--all', help: 'Document every in-scope screen, not only the screens this change touches.' },
      { name: '--html', help: 'Print them as one HTML page instead.' },
      STATIC_ONLY_FLAG,
      CONFIG_FLAG,
    ],
  },
  {
    name: 'comment',
    usage: 'usabl comment [options] < usabl-result.json',
    summary: 'Turn a JSON result on stdin into a pull request comment.',
    flags: [CONFIG_FLAG],
  },
  {
    name: 'enforce',
    usage: 'usabl enforce accessibility|policy [options] < usabl-result.json',
    summary: 'Turn a JSON result on stdin into a CI status for the CI workflow.',
    flags: [
      {
        name: '--trusted-ref',
        value: '<git-ref>',
        help: 'Needed for enforce policy: the git ref that holds the trusted policy.',
      },
    ],
  },
  {
    name: 'stop-hook',
    usage: 'usabl stop-hook [options] < hook-input.json',
    summary: 'The command the Claude Code and Cursor stop hooks run.',
    flags: [{ name: '--cursor', help: "Answer in Cursor's hook format." }],
  },
  {
    name: 'bypass',
    usage: 'usabl bypass',
    summary: 'Let the stop hook allow the next stop once. Changes no verdict.',
    flags: [],
  },
  {
    name: 'help',
    usage: 'usabl help [command]',
    summary: 'Print this help, or the help for one command.',
    flags: [],
  },
];

const DOCS_URL = 'https://usabl-dev.github.io/usabl/';

export function findCliCommand(name: string): CliCommand | undefined {
  return CLI_COMMANDS.find((command) => command.name === name);
}

function pad(text: string, width: number): string {
  return text.length >= width ? `${text} ` : text.padEnd(width);
}

export function formatHelp(): string {
  const width = Math.max(...CLI_COMMANDS.map((command) => command.name.length)) + 2;
  return [
    'usabl checks the screens a change touches for accessibility barriers.',
    '',
    'Usage: usabl <command> [options]',
    '       usabl <command> --help',
    '',
    'Commands:',
    ...CLI_COMMANDS.map((command) => `  ${pad(command.name, width)}${command.summary}`),
    '',
    'With no command, usabl runs check.',
    'Exit codes: 0 verified or nothing to check, 1 regression,',
    '  2 approval required or refused, 3 not covered, 4 run failed.',
    `Docs: ${DOCS_URL}`,
    '',
  ].join('\n');
}

function flagLabel(flag: CliFlag): string {
  return flag.value === undefined ? flag.name : `${flag.name} ${flag.value}`;
}

export function formatCommandHelp(command: CliCommand): string {
  const help: CliFlag = { name: '--help', help: 'Print this help. -h works too.' };
  const flags = [...command.flags, help];
  // Each flag's help goes on its own line under the flag, so no line runs past 80 columns.
  return [
    `usabl ${command.name}: ${command.summary}`,
    '',
    `Usage: ${command.usage}`,
    '',
    'Options:',
    ...flags.flatMap((flag) => [`  ${flagLabel(flag)}`, `      ${flag.help}`]),
    '',
  ].join('\n');
}

export type CliPreflight = { kind: 'help'; text: string } | { kind: 'refuse'; message: string } | null;

const VALUE_FLAGS = new Set(
  CLI_COMMANDS.flatMap((command) => command.flags.filter((flag) => flag.value !== undefined).map((flag) => flag.name)),
);

function unknownCommand(name: string): string {
  return `unknown command: ${neutralize(name)}. Run "usabl help" to list the commands.`;
}

/**
 * What to do before any command runs: print help, refuse, or go on. Help is answered here so that
 * asking for it never loads config, opens a browser, or writes a file. A flag the command does not
 * take is refused rather than ignored, because an ignored flag ran a whole check for a reader who
 * only asked how to use the tool.
 */
export function preflightCli(argv: readonly string[]): CliPreflight {
  const flags: string[] = [];
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (!token.startsWith('-')) {
      positionals.push(token);
      continue;
    }
    flags.push(token);
    const next = argv[index + 1];
    if (VALUE_FLAGS.has(token) && next !== undefined && !next.startsWith('-')) {
      index += 1;
    }
  }

  const helpFlag = flags.some((flag) => HELP_FLAGS.includes(flag));
  const helpWords = positionals.filter((positional) => positional === 'help').length;
  if (helpFlag || helpWords > 0) {
    const topic = positionals.find((positional) => positional !== 'help');
    if (topic === undefined) {
      // `usabl help --help` and `usabl help help` ask about the help command itself.
      const aboutHelp = helpWords > 1 || (helpWords === 1 && helpFlag);
      const help = findCliCommand('help');
      return { kind: 'help', text: aboutHelp && help !== undefined ? formatCommandHelp(help) : formatHelp() };
    }
    const command = findCliCommand(topic);
    return command === undefined
      ? { kind: 'refuse', message: unknownCommand(topic) }
      : { kind: 'help', text: formatCommandHelp(command) };
  }

  let name: string;
  try {
    name = parseCliArgs([...argv]).command;
  } catch {
    // A flag missing its value. The parser's own message says which, so leave it to the caller.
    return null;
  }
  const command = findCliCommand(name);
  if (command === undefined) {
    return { kind: 'refuse', message: unknownCommand(name) };
  }
  const accepted = new Set(command.flags.map((flag) => flag.name));
  const unknown = flags.find((flag) => !accepted.has(flag));
  if (unknown !== undefined) {
    return {
      kind: 'refuse',
      message: `${command.name} does not take ${neutralize(unknown)}. Run "usabl ${command.name} --help" to list its options.`,
    };
  }
  return null;
}
