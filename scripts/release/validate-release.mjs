import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u
const HEADING = /^## \[([^\]]+)\](?:\s+-\s+\d{4}-\d{2}-\d{2})?\s*$/gmu

export async function validateRelease({
  version,
  mode,
  changelogPath,
  packagePath,
  desktopPackagePath,
  tag
}) {
  if (!SEMVER.test(version)) throw new Error(`Invalid semantic version: ${version}`)
  if (!['candidate', 'unreleased'].includes(mode)) {
    throw new Error('Mode must be candidate or unreleased')
  }
  if (tag !== undefined && tag !== `v${version}`) {
    throw new Error(`Tag ${tag} must exactly match v${version}`)
  }

  const [rootPackage, desktopPackage, changelog] = await Promise.all([
    readJsonObject(packagePath, 'root package'),
    readJsonObject(desktopPackagePath, 'desktop package'),
    readFile(resolve(changelogPath), 'utf8')
  ])
  for (const [label, manifest] of [
    ['root package', rootPackage],
    ['desktop package', desktopPackage]
  ]) {
    if (manifest.version !== version) {
      throw new Error(`${label} version ${String(manifest.version)} does not match ${version}`)
    }
  }
  for (const scriptName of ['release:checksums', 'release:verify']) {
    const command = desktopPackage.scripts?.[scriptName]
    const tokens = typeof command === 'string' ? command.trim().split(/\s+/u) : []
    const versionIndex = tokens.indexOf('--version')
    if (versionIndex < 0 || tokens[versionIndex + 1] !== version) {
      throw new Error(`desktop ${scriptName} must pass --version ${version}`)
    }
  }
  if (mode === 'candidate') validateReleaseHomepage(desktopPackage.homepage)

  const sections = changelogSections(changelog)
  const sectionName = mode === 'candidate' ? version : 'Unreleased'
  const notes = sections.get(sectionName)
  if (notes === undefined) throw new Error(`CHANGELOG.md has no [${sectionName}] section`)
  if (!/^###\s+\S/mu.test(notes) || !/^\s*-\s+\S/mu.test(notes)) {
    throw new Error(`CHANGELOG.md [${sectionName}] must contain a subsection and an entry`)
  }
  if (mode === 'candidate' && sections.has('Unreleased') && sections.get('Unreleased') === notes) {
    throw new Error('Candidate notes must be in a versioned section')
  }
  return { notes: notes.trim(), prerelease: version.includes('-'), version }
}

function validateReleaseHomepage(value) {
  let homepage
  try {
    homepage = new URL(value)
  } catch {
    throw new Error('desktop package homepage must be a public HTTPS URL')
  }
  if (
    homepage.protocol !== 'https:' ||
    homepage.username ||
    homepage.password ||
    homepage.search ||
    homepage.hash ||
    homepage.hostname.endsWith('.invalid') ||
    homepage.hostname === 'localhost'
  ) {
    throw new Error('desktop package homepage must be a public HTTPS URL')
  }
}

function changelogSections(changelog) {
  const matches = [...changelog.matchAll(HEADING)]
  const sections = new Map()
  for (const [index, match] of matches.entries()) {
    const name = match[1]
    if (sections.has(name)) throw new Error(`Duplicate CHANGELOG.md section: ${name}`)
    sections.set(name, changelog.slice(match.index + match[0].length, matches[index + 1]?.index).trim())
  }
  return sections
}

async function readJsonObject(path, label) {
  let value
  try {
    value = JSON.parse(await readFile(resolve(path), 'utf8'))
  } catch (error) {
    throw new Error(`Cannot read ${label}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error
    })
  }
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`${label} must be a JSON object`)
  }
  return value
}

function parseArguments(args) {
  const allowed = new Set([
    '--version',
    '--mode',
    '--changelog',
    '--package',
    '--desktop-package',
    '--tag',
    '--notes-output'
  ])
  const values = new Map()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (!allowed.has(key) || value === undefined || value.startsWith('--') || values.has(key)) {
      throw new Error(`Invalid release validation argument: ${key ?? '<missing>'}`)
    }
    values.set(key, value)
  }
  if (!values.has('--version') || !values.has('--mode')) {
    throw new Error('--version and --mode are required')
  }
  return {
    version: values.get('--version'),
    mode: values.get('--mode'),
    changelogPath: values.get('--changelog') ?? 'CHANGELOG.md',
    packagePath: values.get('--package') ?? 'package.json',
    desktopPackagePath: values.get('--desktop-package') ?? 'apps/desktop/package.json',
    tag: values.get('--tag'),
    notesOutput: values.get('--notes-output')
  }
}

async function run() {
  const options = parseArguments(process.argv.slice(2))
  const result = await validateRelease(options)
  if (options.notesOutput !== undefined) {
    const destination = resolve(options.notesOutput)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, `${result.notes}\n`, { encoding: 'utf8', flag: 'wx' })
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
