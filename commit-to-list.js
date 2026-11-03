import _debug from 'debug'
import { execFile as _execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { Readable, pipeline as _pipeline } from 'stream'
import { promisify } from 'util'
import commitStream from 'commit-stream'
import { isReleaseCommit } from './groups.js'

const debug = _debug('changelog-maker')

const pipeline = promisify(_pipeline)
const execFile = promisify(_execFile)

async function git (...args) {
  const { stdout } = await execFile('git', args)
  return stdout.trim()
}

async function resolveRef (ref) {
  try {
    return await git('rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`)
  } catch {
    throw new Error(`unknown git ref: ${ref}`)
  }
}

// most recent commit tagged like a version, falling back to HEAD
async function defaultStartRef () {
  for (const rev of ['--tags=v*.*.*', '--tags=*.*.*', 'HEAD']) {
    const sha = await git('rev-list', '--max-count=1', rev).catch(() => '')
    if (sha) {
      return sha
    }
  }
  throw new Error('could not determine a start ref')
}

async function startRef (argv) {
  if (argv.a || argv.all) {
    // the oldest root commit
    return (await git('rev-list', '--max-parents=0', 'HEAD')).split('\n').pop()
  }
  return argv['start-ref'] ? resolveRef(argv['start-ref']) : defaultStartRef()
}

function commitDate (sha) {
  return git('show', '-s', '--format=%cd', sha)
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
  const args = ['log', '--pretty=full', `--since=${await commitDate(await startRef(argv))}`]
  if (argv['end-ref']) {
    args.push(`--until=${await commitDate(await resolveRef(argv['end-ref']))}`)
  }
  debug('git %o', args)

  let commitList = []
  const child = spawn('git', args, { stdio: ['ignore', 'pipe', 'inherit'] })
  const [[code, signal]] = await Promise.all([
    once(child, 'close'),
    pipeline(
      Readable.from(createInterface({ input: child.stdout, crlfDelay: Infinity })),
      commitStream(ghId.user, ghId.repo),
      async function * (source) {
        for await (const commit of source) {
          commitList.push(commit)
        }
      })
  ])
  if (code || signal) {
    throw new Error(`git command [git ${args.join(' ')}] exited with ${signal ? `signal ${signal}` : `code ${code}`}`)
  }
  commitList = organiseCommits(argv, commitList)
  return commitList
}
