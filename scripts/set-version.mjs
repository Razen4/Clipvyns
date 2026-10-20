import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const checkOnly = process.argv[2] === '--check'
const requestedVersion = process.argv[checkOnly ? 3 : 2]

if (!requestedVersion || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(requestedVersion)) {
  throw new Error('Usage: npm run version:set -- 1.2.3 (or npm run version:check -- 1.2.3)')
}

const packagePath = resolve(root, 'package.json')
const lockPath = resolve(root, 'package-lock.json')
const tauriPath = resolve(root, 'src-tauri', 'tauri.conf.json')
const cargoPath = resolve(root, 'src-tauri', 'Cargo.toml')
const cargoLockPath = resolve(root, 'src-tauri', 'Cargo.lock')
const readmePath = resolve(root, 'README.md')

const packageJson = JSON.parse(await readFile(packagePath, 'utf8'))
const packageLock = JSON.parse(await readFile(lockPath, 'utf8'))
const tauriConfig = JSON.parse(await readFile(tauriPath, 'utf8'))
const cargoToml = await readFile(cargoPath, 'utf8')
const cargoLock = await readFile(cargoLockPath, 'utf8')
const readme = await readFile(readmePath, 'utf8')

const cargoVersion = cargoToml.match(/^\[package\][\s\S]*?^version = "([^"]+)"/m)?.[1]
const cargoLockVersion = cargoLock.match(/^\[\[package\]\]\r?\nname = "clipboard-sharings"\r?\nversion = "([^"]+)"/m)?.[1]
const versions = {
  'package.json': packageJson.version,
  'package-lock.json': packageLock.version,
  'package-lock.json root package': packageLock.packages?.['']?.version,
  'src-tauri/tauri.conf.json': tauriConfig.version,
  'src-tauri/Cargo.toml': cargoVersion,
  'src-tauri/Cargo.lock': cargoLockVersion,
  'README.md': readme.match(/^Current version: \*\*([^*]+)\*\*$/m)?.[1],
}

if (checkOnly) {
  const mismatches = Object.entries(versions).filter(([, version]) => version !== requestedVersion)
  if (mismatches.length) {
    throw new Error(`Expected version ${requestedVersion}: ${mismatches.map(([file, version]) => `${file}=${version}`).join(', ')}`)
  }
  console.log(`All project versions match ${requestedVersion}.`)
  process.exit(0)
}

packageJson.version = requestedVersion
packageLock.version = requestedVersion
packageLock.packages[''].version = requestedVersion
tauriConfig.version = requestedVersion

const updatedCargoToml = cargoToml.replace(
  /(^\[package\][\s\S]*?^version = ")[^"]+("$)/m,
  `$1${requestedVersion}$2`,
)
const updatedCargoLock = cargoLock.replace(
  /(^\[\[package\]\]\r?\nname = "clipboard-sharings"\r?\nversion = ")[^"]+("$)/m,
  `$1${requestedVersion}$2`,
)
const updatedReadme = readme
  .replace(/(^Current version: \*\*)[^*]+(\*\*$)/m, `$1${requestedVersion}$2`)
  .replace(/(^npm run version:set -- )\S+$/m, `$1${requestedVersion}`)
  .replace(/(^npm run version:check -- )\S+$/m, `$1${requestedVersion}`)
  .replace(/(^git commit -m "chore: release v)[^"]+("$)/m, `$1${requestedVersion}$2`)
  .replace(/(^git tag v)\S+$/m, `$1${requestedVersion}`)
  .replace(/(^git push origin main v)\S+$/m, `$1${requestedVersion}`)

await Promise.all([
  writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`),
  writeFile(lockPath, `${JSON.stringify(packageLock, null, 2)}\n`),
  writeFile(tauriPath, `${JSON.stringify(tauriConfig, null, 2)}\n`),
  writeFile(cargoPath, updatedCargoToml),
  writeFile(cargoLockPath, updatedCargoLock),
  writeFile(readmePath, updatedReadme),
])

console.log(`Updated project version to ${requestedVersion}.`)
