import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url))

async function readRepositoryFile(path) {
  return readFile(resolve(repositoryRoot, path), 'utf8')
}

test('release validation documentation uses supported command syntax', async () => {
  const contributing = await readRepositoryFile('CONTRIBUTING.md')
  const releasing = await readRepositoryFile('docs/RELEASING.md')

  assert.match(
    contributing,
    /^pnpm release:validate --version 0\.1\.0 --mode unreleased$/mu
  )
  assert.doesNotMatch(contributing, /release:validate -- --version\b/u)
  assert.match(
    releasing,
    /`pnpm release:validate --version x\.y\.z --mode candidate --tag vx\.y\.z`/u
  )
  assert.doesNotMatch(releasing, /release:validate -- --version\b/u)
  assert.doesNotMatch(contributing, /--mode development\b/u)
})

test('performance documentation uses existing paths and root-runnable filtered commands', async () => {
  const performance = await readRepositoryFile('docs/PERFORMANCE.md')

  assert.match(
    performance,
    /`apps\/desktop\/scripts\/performance\/baseline\.schema\.json`/u
  )
  assert.doesNotMatch(
    performance,
    /(?<!apps\/desktop\/)scripts\/performance\/baseline\.schema\.json/u
  )
  for (const script of ['test:performance:helpers', 'performance:smoke', 'performance:soak']) {
    assert.match(
      performance,
      new RegExp(`^pnpm --filter @agent-workspace/desktop ${script}(?: |$)`, 'mu')
    )
    assert.doesNotMatch(performance, new RegExp(`^pnpm ${script}(?: |$)`, 'mu'))
  }
  assert.match(performance, /^pnpm --filter @agent-workspace\/desktop performance:smoke -- --baseline /mu)
  assert.match(
    performance,
    /^pnpm --silent --filter @agent-workspace\/desktop performance:analyze-soak -- \/tmp\/agent-workspace-performance-soak\.json > \/tmp\/agent-workspace-performance-soak-analysis\.json$/mu
  )
  assert.doesNotMatch(
    performance,
    /^pnpm --filter @agent-workspace\/desktop performance:analyze-soak\b/mu
  )
})

test('latest packaged idle CPU evidence stays consistent across public documentation', async () => {
  const paths = [
    'README.md',
    'CHANGELOG.md',
    'ROADMAP.md',
    'docs/ARCHITECTURE.md',
    'docs/IMPLEMENTATION_SPEC.md',
    'docs/KNOWN_LIMITATIONS.md',
    'docs/PERFORMANCE.md'
  ]
  const evidence = await Promise.all(
    paths.map(async (path) => {
      const paragraphs = (await readRepositoryFile(path))
        .split(/\n\s*\n/u)
        .filter(
          (paragraph) =>
            /(?:idle.{0,100}CPU|CPU.{0,100}idle)/isu.test(paragraph) &&
            /\b\d+\.\d+%/u.test(paragraph)
        )
      assert.equal(paragraphs.length, 1, `${path} must have one latest idle CPU evidence paragraph`)
      const percentages = paragraphs[0].match(/\b\d+\.\d+%/gu) ?? []
      assert.equal(percentages.length, 1, `${path} must report one decimal idle CPU percentage`)
      return percentages[0]
    })
  )

  assert.equal(new Set(evidence).size, 1, `idle CPU evidence differs: ${evidence.join(', ')}`)
})

test('README distinguishes Node release candidate checks from unfinished qualification', async () => {
  const readme = await readRepositoryFile('README.md')

  assert.match(
    readme,
    /release-candidate\s+workflow retains direct accessibility and visual validation/u
  )
  assert.match(readme, /Node performance\s+qualification and manual gates remain open/u)
  assert.doesNotMatch(readme, /does not run the accessibility or performance suites/u)
})

test('release qualification template requires durable evidence without implying a pass', async () => {
  const [readme, releasing, qualification] = await Promise.all([
    readRepositoryFile('README.md'),
    readRepositoryFile('docs/RELEASING.md'),
    readRepositoryFile('docs/RELEASE_QUALIFICATION.md')
  ])

  assert.match(readme, /\[qualification record\]\(docs\/RELEASE_QUALIFICATION\.md\)/u)
  assert.match(releasing, /\[release qualification record\]\(RELEASE_QUALIFICATION\.md\)/u)
  assert.match(qualification, /This file is a template, not evidence that any check has passed\./u)
  assert.match(
    qualification,
    /Use only these status values: `PASS`, `FAIL`, `NOT RUN`, and `NOT APPLICABLE`\./u
  )
  assert.match(
    qualification,
    /Every pre-publication\s+required check marked `FAIL` or `NOT RUN` blocks publication\./u
  )
  assert.match(qualification, /`NOT APPLICABLE` needs a release-scope rationale\./u)
  assert.match(
    qualification,
    /criterion 10 and the\s+publication-record fields are post-publication closeout/u
  )
  assert.match(qualification, /must become `PASS` immediately afterward/u)
  assert.match(qualification, /A\s+closeout failure requires rollback\./u)
  assert.match(qualification, /Do not use a local `\/tmp` path/u)
  assert.equal(qualification.match(/^\| (?:[1-9]|1[0-2])\s+\|/gmu)?.length, 12)

  for (const heading of [
    'Performance and stability',
    'Accessibility and native interaction',
    'Native macOS and Windows qualification',
    'Identity, updates, and publication readiness',
    'Version 1.0 acceptance criteria',
    'Findings, exceptions, and approval',
    'Publication or rollback record'
  ]) {
    assert.match(qualification, new RegExp(`^## ${heading}$`, 'mu'))
  }
  for (const requiredConcept of [
    /Exact eight-hour report/u,
    /Manual bounded-growth verdict/u,
    /Human screen-reader workflow/u,
    /Native OS zoom and high-contrast review/u,
    /macOS Developer ID signature/u,
    /Windows Authenticode signature/u,
    /Independent public name/u,
    /Real stable\/beta feed origin/u,
    /Second maintainer qualification/u
  ]) {
    assert.match(qualification, requiredConcept)
  }
})

test('release documentation records software fallback without overstating native Linux coverage', async () => {
  const [releasing, qualification] = await Promise.all([
    readRepositoryFile('docs/RELEASING.md'),
    readRepositoryFile('docs/RELEASE_QUALIFICATION.md')
  ])

  assert.match(releasing, /Ubuntu 24\.04 software-rendering/u)
  assert.match(releasing, /Electron `--disable-gpu`/u)
  assert.match(releasing, /Ubuntu 24\.04 headless Wayland/u)
  assert.match(releasing, /Arch Linux container/u)
  assert.match(releasing, /All six inspections require `resources\/node-linux\/bin\/node`/u)
  assert.match(releasing, /headless native-Wayland process readiness/u)
  assert.match(releasing, /rolling-distribution readiness in a pinned official container/u)
  for (const unproven of ['real Wayland input/focus', 'native desktop compositor', 'GPU acceleration', 'ARM64']) {
    assert.match(releasing, new RegExp(`do not verify[\\s\\S]*${unproven}`, 'u'))
  }
  assert.match(qualification, /Extracted AppImage software-rendering fallback/u)
  assert.match(qualification, /Headless native-Wayland renderer\/service readiness/u)
  assert.match(qualification, /Arch Linux extracted AppImage inspection and X11 launch/u)
  assert.match(qualification, /Wayland and X11 launch\/input\/focus comparison/u)
})
