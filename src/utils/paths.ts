import { homedir } from 'os';
import { resolve } from 'path';

export function resolveMetaclawDir(
  envMetaclawHome = process.env.METACLAW_HOME,
  userHome = homedir(),
  envXdgDataHome = process.env.XDG_DATA_HOME,
): string {
  if (envMetaclawHome && envMetaclawHome.trim().length > 0) {
    return resolve(envMetaclawHome);
  }

  const dataHome = envXdgDataHome?.trim();
  return dataHome
    ? resolve(dataHome, 'anyfusion')
    : resolve(userHome, '.local', 'share', 'anyfusion');
}

export function resolveAnyFusionConfigHome(
  envConfigHome = process.env.ANYFUSION_CONFIG_HOME,
  userHome = homedir(),
): string {
  if (envConfigHome && envConfigHome.trim().length > 0) {
    return resolve(envConfigHome);
  }

  return resolve(userHome, '.config', 'anyfusion');
}
