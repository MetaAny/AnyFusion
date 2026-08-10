export interface CliArgs {
  projectPath?: string;
  scriptPath?: string;
  gateway?: boolean;
  connect?: boolean;
  gatewayCommand?: 'setup' | 'run' | 'install' | 'start' | 'stop' | 'restart' | 'status' | 'pairing' | 'doctor';
  gatewayPairingCommand?: 'list' | 'approve' | 'revoke';
  gatewayPairingUserId?: string;
  executorCommand?: 'discover' | 'register' | 'verify' | 'enable' | 'disable' | 'show' | 'list' | 'reload';
  executorArgs?: string[];
}

export function parseCliArgs(argv: string[]): CliArgs {
  if (argv[0] === 'executor') {
    const command = argv[1];
    if (!['discover', 'register', 'verify', 'enable', 'disable', 'show', 'list', 'reload'].includes(command ?? '')) {
      throw new Error(`未知 executor 子命令: ${command ?? '(missing)'}`);
    }
    return {
      executorCommand: command as NonNullable<CliArgs['executorCommand']>,
      executorArgs: argv.slice(2),
    };
  }
  const gatewaySubcommand = parseGatewaySubcommand(argv);
  const projectFlagIndex = argv.findIndex(arg => arg === '--project');
  const projectPath = projectFlagIndex === -1 ? undefined : argv[projectFlagIndex + 1];
  if (projectFlagIndex !== -1 && (!projectPath || projectPath.startsWith('--'))) {
    throw new Error('缺少项目路径。用法: anyfusion --project <项目目录>');
  }
  const gateway = argv.includes('--gateway') || gatewaySubcommand?.command === 'run';
  const connect = argv.includes('--connect');
  const scriptFlagIndex = argv.findIndex(arg => arg === '--script');
  if (scriptFlagIndex === -1) {
    return {
      gateway,
      connect,
      ...(projectPath ? { projectPath } : {}),
      ...(gatewaySubcommand ? { gatewayCommand: gatewaySubcommand.command } : {}),
      ...gatewaySubcommand?.pairing,
    };
  }

  const scriptPath = argv[scriptFlagIndex + 1];
  if (!scriptPath) {
    throw new Error('缺少脚本路径。用法: metaclaw --script <脚本文件>');
  }

  return {
    scriptPath,
    gateway,
    connect,
    ...(projectPath ? { projectPath } : {}),
    ...(gatewaySubcommand ? { gatewayCommand: gatewaySubcommand.command } : {}),
    ...gatewaySubcommand?.pairing,
  };
}

function parseGatewaySubcommand(argv: string[]): {
  command: NonNullable<CliArgs['gatewayCommand']>;
  pairing?: Pick<CliArgs, 'gatewayPairingCommand' | 'gatewayPairingUserId'>;
} | undefined {
  const gatewayIndex = argv.findIndex(arg => arg === 'gateway');
  if (gatewayIndex === -1) {
    return undefined;
  }

  const command = argv[gatewayIndex + 1] ?? 'run';
  if (command === 'pairing') {
    const pairingCommand = argv[gatewayIndex + 2] ?? 'list';
    if (pairingCommand !== 'list' && pairingCommand !== 'approve' && pairingCommand !== 'revoke') {
      throw new Error(`未知 gateway pairing 子命令: ${pairingCommand}`);
    }
    return {
      command,
      pairing: {
        gatewayPairingCommand: pairingCommand,
        ...(argv[gatewayIndex + 3] ? { gatewayPairingUserId: argv[gatewayIndex + 3] } : {}),
      },
    };
  }
  if (
    command === 'setup'
    || command === 'run'
    || command === 'install'
    || command === 'doctor'
    || command === 'start'
    || command === 'stop'
    || command === 'restart'
    || command === 'status'
  ) {
    return { command };
  }
  throw new Error(`未知 gateway 子命令: ${command}`);
}
