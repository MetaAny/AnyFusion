import { describe, expect, it } from 'vitest';
import { parseCliArgs } from '../../src/cli/args.js';

describe('parseCliArgs', () => {
  it('parses script mode from argv', () => {
    expect(parseCliArgs(['--script', '/tmp/metaclaw-flow.txt'])).toEqual({
      scriptPath: '/tmp/metaclaw-flow.txt',
      gateway: false,
      connect: false,
    });
  });

  it('returns empty options when no script mode is requested', () => {
    expect(parseCliArgs([])).toEqual({
      gateway: false,
      connect: false,
    });
  });

  it('parses an explicit Project path in interactive and script modes', () => {
    expect(parseCliArgs(['--project', '/tmp/project'])).toEqual({
      projectPath: '/tmp/project',
      gateway: false,
      connect: false,
    });
    expect(parseCliArgs(['--project', '/tmp/project', '--script', '/tmp/flow.txt'])).toEqual({
      projectPath: '/tmp/project',
      scriptPath: '/tmp/flow.txt',
      gateway: false,
      connect: false,
    });
    expect(() => parseCliArgs(['--project'])).toThrow('缺少项目路径');
  });

  it('parses gateway and connect modes from argv', () => {
    expect(parseCliArgs(['--gateway'])).toEqual({
      gateway: true,
      connect: false,
    });
    expect(parseCliArgs(['--connect'])).toEqual({
      gateway: false,
      connect: true,
    });
  });

  it('parses supported gateway subcommands without breaking gateway flags', () => {
    expect(parseCliArgs(['gateway', 'setup'])).toEqual({
      gateway: false,
      connect: false,
      gatewayCommand: 'setup',
    });
    expect(parseCliArgs(['gateway', 'run'])).toEqual({
      gateway: true,
      connect: false,
      gatewayCommand: 'run',
    });
    expect(parseCliArgs(['gateway'])).toEqual({
      gateway: true,
      connect: false,
      gatewayCommand: 'run',
    });
    expect(parseCliArgs(['gateway', 'pairing', 'approve', 'ou_user'])).toEqual({
      gateway: false,
      connect: false,
      gatewayCommand: 'pairing',
      gatewayPairingCommand: 'approve',
      gatewayPairingUserId: 'ou_user',
    });
    expect(parseCliArgs(['gateway', 'doctor'])).toEqual({
      gateway: false,
      connect: false,
      gatewayCommand: 'doctor',
    });
  });

  it('rejects unknown gateway subcommands', () => {
    expect(() => parseCliArgs(['gateway', 'deploy'])).toThrow('未知 gateway 子命令');
    expect(() => parseCliArgs(['gateway', 'install'])).toThrow('未知 gateway 子命令');
    expect(() => parseCliArgs(['gateway', 'pairing', 'unknown'])).toThrow('未知 gateway pairing 子命令');
  });
});
