'use strict'
Object.defineProperty(exports, '__esModule', {
  value: true
})
exports.Merge = exports.Remote = exports.UnknownObjectId = exports.GitConflict = exports.BranchNotFound = exports.RepoNotFound = exports.Oid = exports.Commit = exports.Repository = void 0
const fs_1 = require('fs')
const path_1 = require('path')
const { Tree } = require('./git/tree')
const { unlink } = fs_1.promises
// End temporary type wrangling
const isomorphic_git_1 = require('isomorphic-git')
const mutex = require('./git_mutex')
const http = require('isomorphic-git/http/node')
const onAuth = () => {
  return {
    username: process.env.GIT_USER,
    password: process.env.GIT_PASS
  }
}
//isomorphic_git_1.plugins.set('fs', fs_1);
const moment_timezone_1 = require('moment-timezone')
class Repository {
  constructor(path, bare = false) {
    this.path = path
    this.bare = bare
    if (bare) {
      this.gitdir = path
    } else {
      this.gitdir = path_1.join(path, '.git')
    }
  }
  static async open(path) {
    let bare = !fs_1.existsSync(path_1.join(path, '.git'))
    const release = await mutex.acquire()
    try {
      let opts = {
        fs: fs_1
      }
      if (bare) {
        opts.gitdir = path
      } else {
        opts.dir = path
      }
      // Try to get the current branch to check if it's really a git repo or not
      await isomorphic_git_1.currentBranch(opts)
    } catch (e) {
      throw new Error(e)
    } finally {
      release()
    }
    return new Repository(path, bare)
  }
  static async initBare(gitdir) {
    const release = await mutex.acquire()
    try {
      await isomorphic_git_1.init({
        gitdir,
        bare: true
      })
    } finally {
      release()
    }
    return await Repository.open(gitdir)
  }
  static async clone(url, dir) {
    const release = await mutex.acquire()
    try {
      await isomorphic_git_1.clone({
        fs: fs_1,
        onAuth,
        http,
        url,
        dir
      })
    } finally {
      release()
    }
    return await Repository.open(dir)
  }
  async getMasterCommit() {
    const release = await mutex.acquire()
    let sha
    try {
      sha = await isomorphic_git_1.resolveRef({
        fs: fs_1,
        gitdir: this.gitdir,
        ref: 'master'
      })
    } finally {
      release()
    }
    return await Commit.lookup(this, sha)
  }
  async getRemote(remote) {
    return new Remote(this, remote)
  }
  async createBlobFromBuffer(buffer) {
    const release = await mutex.acquire()
    let sha
    try {
      sha = await isomorphic_git_1.writeBlob({
        fs: fs_1,
        gitdir: this.gitdir,
        blob: buffer
      })
    } finally {
      release()
    }
    return new Oid(sha)
  }
  async fetchAll() {
    const release = await mutex.acquire()
    try {
      await isomorphic_git_1.fetch({
        onAuth,
        http,
        fs: fs_1,
        gitdir: this.gitdir
      })
    } finally {
      release()
    }
  }
  async mergeBranches(to, from) {
    const release = await mutex.acquire()
    try {
      await isomorphic_git_1.merge({
        fs: fs_1,
        gitdir: this.gitdir,
        ours: to,
        theirs: from,
        fastForwardOnly: true
      })
    } finally {
      release()
    }
  }
  async getReference(branchName) {
    return await Reference.lookup(this, branchName)
  }
  async createBranch(targetBranch, headCommit) {
    const release = await mutex.acquire()
    try {
      await isomorphic_git_1.writeRef({
        fs: fs_1,
        gitdir: this.gitdir,
        ref: `refs/heads/${targetBranch}`,
        value: headCommit.sha(),
        force: true
      })
    } finally {
      release()
    }
    return await Reference.lookup(this, targetBranch)
  }
  async checkoutBranch(reference) {
    const release = await mutex.acquire()
    try {
      await isomorphic_git_1.checkout({
        fs: fs_1,
        dir: this.path,
        gitdir: this.gitdir,
        ref: reference.toString()
      })
    } finally {
      release()
    }
  }
  async getHeadCommit() {
    return await Commit.lookup(this, 'HEAD')
  }
  async getReferenceCommit(name) {
    return await Commit.lookup(this, name)
  }
  async lookupLocalBranch(branchName) {
    const release = await mutex.acquire()
    let branches
    try {
      branches = await isomorphic_git_1.listBranches({
        fs: fs_1,
        gitdir: this.gitdir
      })
    } finally {
      release()
    }
    if (branches.includes(branchName)) {
      return await this.lookupReference(`refs/heads/${branchName}`)
    } else {
      throw new BranchNotFound()
    }
  }
  async lookupRemoteBranch(remote, branchName) {
    let branches
    const release = await mutex.acquire()
    try {
      branches = await isomorphic_git_1.listBranches({
        fs: fs_1,
        gitdir: this.gitdir,
        remote
      })
    } finally {
      release()
    }
    if (branches.includes(branchName)) {
      return await this.lookupReference(`refs/remotes/${remote}/${branchName}`)
    } else {
      throw new BranchNotFound()
    }
  }
  async lookupReference(reference) {
    return await Reference.lookup(this, reference)
  }
  async reset(commit, hard) {
    let release = await mutex.acquire()
    let ref
    try {
      ref = await isomorphic_git_1.currentBranch({
        fs: fs_1,
        gitdir: this.gitdir,
        fullname: true
      })
      await isomorphic_git_1.writeRef({
        fs: fs_1,
        gitdir: this.gitdir,
        ref: ref,
        value: commit.sha()
      })
      if (hard) {
        await unlink(path_1.join(this.gitdir, 'index'))
        await isomorphic_git_1.checkout({
          fs: fs_1,
          dir: this.path,
          ref: ref
        })
      }
    } finally {
      release()
    }
  }
  isBare() {
    return this.bare
  }
}
exports.Repository = Repository
class Commit {
  constructor(repo, commitInfo) {
    this.repo = repo
    this.commitInfo = commitInfo
  }
  static async create(repo, commitOpts, tree, parents) {
    const release = await mutex.acquire()
    let sha
    try {
      sha = await isomorphic_git_1.commit(
        Object.assign(formatCommitOpts(commitOpts), {
          fs: fs_1,
          gitdir: repo.gitdir,
          tree: tree.id().toString(),
          parent: parents.map(p => p.sha()),
          noUpdateBranch: true
        })
      )
    } finally {
      release()
    }
    return new Oid(sha)
  }
  static async lookup(repo, id) {
    const release = await mutex.acquire()
    try {
      let commitInfo = await isomorphic_git_1.readCommit({
        fs: fs_1,
        gitdir: repo.gitdir,
        oid: id.toString()
      })
      return new Commit(repo, commitInfo)
    } catch (e) {
      if (e.code == 'ReadObjectFail') {
        throw new UnknownObjectId()
      } else {
        throw e
      }
    } finally {
      release()
    }
  }
  id() {
    return new Oid(this.commitInfo.oid)
  }
  sha() {
    return this.commitInfo.oid
  }
  async getLog() {
    const release = await mutex.acquire()
    try {
      return await isomorphic_git_1.log({
        fs: fs_1,
        gitdir: this.repo.gitdir,
        ref: this.sha()
      })
    } finally {
      release()
    }
  }
  async getTree() {
    return await Tree.lookup(this.repo, new Oid(this.commitInfo.commit.tree))
  }
}
exports.Commit = Commit
class Oid {
  constructor(sha) {
    this.sha = sha
  }
  toString() {
    return this.sha
  }
  equal(other) {
    return other && other.toString() === this.toString()
  }
}
exports.Oid = Oid
class RepoNotFound extends Error { }
exports.RepoNotFound = RepoNotFound
class BranchNotFound extends Error { }
exports.BranchNotFound = BranchNotFound
class GitConflict extends Error { }
exports.GitConflict = GitConflict
class UnknownObjectId extends Error { }
exports.UnknownObjectId = UnknownObjectId
class Reference {
  constructor(repo, reference, sha) {
    this.repo = repo
    this.reference = reference
    this.sha = sha
  }
  static async lookup(repo, reference) {
    const release = await mutex.acquire()
    let sha
    try {
      sha = await isomorphic_git_1.resolveRef({
        fs: fs_1,
        gitdir: repo.gitdir,
        ref: reference
      })
    } finally {
      release()
    }
    return new Reference(repo, reference, sha)
  }
  target() {
    return new Oid(this.sha)
  }
  async setTarget(id) {
    const release = await mutex.acquire()
    try {
      await isomorphic_git_1.writeRef({
        fs: fs_1,
        gitdir: this.repo.gitdir,
        ref: this.reference,
        value: id.toString(),
        force: true
      })
    } finally {
      release()
    }
  }
  toString() {
    return this.reference
  }
}
class Remote {
  constructor(repo, remote) {
    this.repo = repo
    this.remote = remote
  }
  static async create(repo, remote, url) {
    const release = await mutex.acquire()
    try {
      await isomorphic_git_1.addRemote({
        fs: fs_1,
        gitdir: await repo.gitdir,
        remote,
        url
      })
    } finally {
      release()
    }
    return new Remote(repo, remote)
  }
  async push(ref, remoteRef, options = {}) {
    const release = await mutex.acquire()
    try {
      await isomorphic_git_1.push(
        Object.assign(
          {
            onAuth,
            http,
            fs: fs_1,
            gitdir: await this.repo.gitdir,
            remote: this.remote,
            ref,
            remoteRef
          },
          options
        )
      )
    } finally {
      release()
    }
  }
}
exports.Remote = Remote

function formatCommitOpts(commitOpts) {
  let commitDate = moment_timezone_1(commitOpts.authorDate || new Date())
  let author = {
    name: commitOpts.authorName,
    email: commitOpts.authorEmail,
    date: commitDate.toDate(),
    timezoneOffset: -commitDate.utcOffset()
  }
  let committer
  if (commitOpts.committerName && commitOpts.committerEmail) {
    committer = {
      name: commitOpts.committerName,
      email: commitOpts.committerEmail
    }
  }
  return {
    author,
    committer,
    message: commitOpts.message
  }
}
let Merge = /** @class */ (() => {
  class Merge {
    static async base(repo, one, two) {
      const release = await mutex.acquire()
      let oids
      try {
        oids = await isomorphic_git_1.findMergeBase({
          fs: fs_1,
          gitdir: repo.gitdir,
          oids: [one.toString(), two.toString()]
        })
      } finally {
        release()
      }
      return new Oid(oids[0])
    }
    static async perform(repo, ourCommit, theirCommit, commitOpts) {
      const release = await mutex.acquire()
      try {
        let res = await isomorphic_git_1.merge(
          Object.assign(formatCommitOpts(commitOpts), {
            fs: fs_1,
            gitdir: repo.gitdir,
            ours: ourCommit.sha(),
            theirs: theirCommit.sha()
          })
        )
        return res
      } catch (e) {
        if (e.code === 'MergeNotSupportedFail') {
          throw new GitConflict()
        } else {
          throw e
        }
      } finally {
        release()
      }
    }
  }
  Merge.FASTFORWARD_ONLY = 2
  return Merge
})()
exports.Merge = Merge
