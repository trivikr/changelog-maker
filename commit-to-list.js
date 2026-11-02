import _debug from 'debug'
import process from 'process'
import { execFile as _execFile } from 'child_process'
import { createInterface } from 'node:readline'
import { Readable, pipeline as _pipeline } from 'stream'
import { promisify } from 'util'
import commitStream from 'commit-stream'
import { isReleaseCommit } from './groups.js'

const debug = _debug('changelog-maker')

const execFile = promisify(_execFile)
const pipeline = promisify(_pipeline)

async function git (...args) {
  debug('git %o', args)
  const { stdout, stderr } = await execFile('git', args, { maxBuffer: Infinity })
  process.stderr.write(stderr)
  return stdout
}

async function resolveRef (ref) {
  // `--end-of-options` stops a ref being read as a flag, `--` stops it being read as a path
  const commit = (await git('rev-list', '--max-count=1', '--end-of-options', ref, '--')).trim()
  if (!commit) {
    throw new Error(`git ref [${ref}] does not resolve to a commit`)
  }
  return commit
}

async function resolveDefaultStartRef () {
  // an unmatched `--tags` glob exits 0 with no output, so fall through on empty
  return (await git('rev-list', '--max-count=1', '--tags=v*.*.*')).trim() ||
    (await git('rev-list', '--max-count=1', '--tags=*.*.*')).trim() ||
    resolveRef('HEAD')
}

async function resolveStartCommits (argv) {
  if (argv.a || argv.all) {
    return (await git('rev-list', '--max-parents=0', 'HEAD')).trim().split('\n')
  }
  return [argv['start-ref'] ? await resolveRef(argv['start-ref']) : await resolveDefaultStartRef()]
}

async function commitDate (commits) {
  return (await git('show', '-s', '--format=%cd', ...commits)).trim()
}

function organiseCommits (argv, list) {
  if (argv['start-ref'] || argv.a || argv.all) {
    if (argv['filter-release']) {
      list = list.filter((commit) => !isReleaseCommit(commit.summary))
    }

    return list
  }

  // filter commits to those _before_ 'working on ...'
  let started = false
  return list.filter((commit) => {
    if (started) {
      return false
    }

    if (isReleaseCommit(commit.summary)) {
      started = true
    }

    return !started
  })
}

export async function commitToList (ghId, argv) {
  const since = await commitDate(await resolveStartCommits(argv))
  const until = argv['end-ref'] ? await commitDate([await resolveRef(argv['end-ref'])]) : ''
  const log = await git('log', '--pretty=full', `--since=${since}`, `--until=${until}`)

  let commitList = []
  await pipeline(
    Readable.from([log]),
    (source) => Readable.from(createInterface({ input: source, crlfDelay: Infinity })),
    commitStream(ghId.user, ghId.repo),
    async function * (source) {
      for await (const commit of source) {
        commitList.push(commit)
      }
    })
  commitList = organiseCommits(argv, commitList)
  return commitList
}
