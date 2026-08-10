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
    ? resolve(dataHome, 'anyfusion', 'runtime')
    : resolve(userHome, '.local', 'share', 'anyfusion', 'runtime');
}

export function resolveAnyFusionConfigHome(
  envConfigHome = process.env.ANYFUSION_CONFIG_HOME,
  userHome = homedir(),
  envXdgConfigHome = process.env.XDG_CONFIG_HOME,
): string {
  if (envConfigHome && envConfigHome.trim().length > 0) {
    return resolve(envConfigHome);
  }

  const configHome = envXdgConfigHome?.trim();
  return configHome
    ? resolve(configHome, 'anyfusion')
    : resolve(userHome, '.config', 'anyfusion');
}
