'use strict'
Object.defineProperty(exports, '__esModule', {
  value: true
})
const git_1 = require('./git')
const { Tree } = require('./git/tree')
const crypto_1 = require('crypto')
const delay_1 = require('delay')
const logger_1 = require('@cardstack/logger')
const log = logger_1('cardstack/git')
class Change {
  constructor(
    repo,
    targetBranch,
    parentTree,
    parents,
    parentCommit,
    isRemote
  ) {
    this.repo = repo
    this.targetBranch = targetBranch
    this.parentTree = parentTree
    this.parents = parents
    this.parentCommit = parentCommit
    this.repo = repo
    this.root = parentTree || Tree.create(repo, parentTree)
    this.isRemote = !!isRemote
  }
  static async createInitial(repoPath, targetBranch) {
    let repo = await git_1.Repository.initBare(repoPath)
    return new this(repo, targetBranch, undefined, [])
  }
  static async createBranch(repo, parentId, targetBranch) {
    let parentCommit
    if (parentId) {
      parentCommit = await git_1.Commit.lookup(repo, parentId)
    }
    let parentTree
    let parents = []
    if (parentCommit) {
      parentTree = await parentCommit.getTree()
      parents.push(parentCommit)
    }
    return new this(repo, targetBranch, parentTree, parents, parentCommit)
  }
  static async create(repo, parentId, targetBranch, isRemote) {
    let parentCommit
    if (parentId) {
      parentCommit = await git_1.Commit.lookup(repo, parentId)
    } else {
      parentCommit = await headCommit(repo, targetBranch, !!isRemote)
    }
    let parentTree
    let parents = []
    if (parentCommit) {
      parentTree = await parentCommit.getTree()
      parents.push(parentCommit)
    }
    return new this(
      repo,
      targetBranch,
      parentTree,
      parents,
      parentCommit,
      isRemote
    )
  }
  async _headCommit() {
    return headCommit(this.repo, this.targetBranch, this.isRemote)
  }
  async get(path, { allowCreate, allowUpdate } = {}) {
    let { tree, leaf, leafName } = await this.root.fileAtPath(
      path,
      !!allowCreate
    )
    return new FileHandle(tree, leaf, leafName, !!allowUpdate, path)
  }
  async finalize(commitOpts) {
    let newCommit = await this._makeCommit(commitOpts)
    let delayTime = 500
    let mergeCommit
    let needsFetchAll = false
    while (delayTime <= 5000) {
      mergeCommit = await this._makeMergeCommit(newCommit, commitOpts)
      try {
        if (this.isRemote) {
          // needsFetchAll only gets set to true if the retry block has failed once
          if (needsFetchAll) {
            // pull remote before allowing process to continue, allowing us to
            // (hopefully) recover from upstream getting out of sync
            await this.repo.fetchAll()
          }
          await this._pushCommit(mergeCommit)
        } else {
          await this._applyCommit(mergeCommit)
        }
      } catch (err) {
        log.warn('Failed to finalize commit "%s"', err)
        needsFetchAll = true
        await delay_1(delayTime)
        delayTime *= 2
        continue
      }
      if (
        this.isRemote &&
        !this.repo.isBare()
      ) {
        await this.repo.fetchAll()
        await this.repo.mergeBranches(
          this.targetBranch,
          `origin/${this.targetBranch}`
        )
      }
      return mergeCommit.id().toString()
    }
    throw new Error('Failed to finalise commit and could not recover. ')
  }
  async _makeCommit(commitOpts) {
    if (!this.root.dirty) {
      return this.parentCommit
    }
    let treeOid = await this.root.write(true)
    let tree = await Tree.lookup(this.repo, treeOid)
    let commitOid = await git_1.Commit.create(
      this.repo,
      commitOpts,
      tree,
      this.parents
    )
    return git_1.Commit.lookup(this.repo, commitOid)
  }
  async _pushCommit(mergeCommit) {
    const remoteBranchName = `temp-remote-${crypto_1
      .randomBytes(20)
      .toString('hex')}`
    await this.repo.createBranch(remoteBranchName, mergeCommit)
    let remote = await this.repo.getRemote('origin')
    try {
      await remote.push(
        `refs/heads/${remoteBranchName}`,
        `refs/heads/${this.targetBranch}`,
        {
          force: true
        }
      )
    } catch (err) {
      // pull remote before allowing process to continue
      await this.repo.fetchAll()
      throw err
    }
  }
  async _makeMergeCommit(newCommit, commitOpts) {
    let headCommit = await this._headCommit()
    if (!headCommit) {
      // new branch, so no merge needed
      return newCommit
    }
    let baseOid = await git_1.Merge.base(
      this.repo,
      newCommit.id(),
      headCommit.id()
    )
    if (baseOid.equal(headCommit.id())) {
      // fast forward (we think), so no merge needed
      return newCommit
    }
    commitOpts.message = `Clean merge into ${this.targetBranch}`
    let mergeResult = await git_1.Merge.perform(
      this.repo,
      newCommit,
      headCommit,
      commitOpts
    )
    return await git_1.Commit.lookup(this.repo, mergeResult.oid)
  }
  async _applyCommit(commit) {
    let headCommit = await this._headCommit()
    if (!headCommit) {
      return await this._newBranch(commit)
    }
    let headRef = await this.repo.lookupLocalBranch(this.targetBranch)
    await headRef.setTarget(commit.id())
  }
  async _newBranch(newCommit) {
    await this.repo.createBranch(this.targetBranch, newCommit)
  }
}
exports.default = Change
class FileHandle {
  constructor(tree, leaf, name, allowUpdate, path) {
    this.tree = tree
    this.leaf = leaf
    this.name = name
    this.allowUpdate = allowUpdate
    this.path = path
    this.tree = tree
    this.leaf = leaf
    this.name = name
    this.allowUpdate = allowUpdate
    this.path = path
    if (leaf) {
      this.mode = leaf.filemode()
    } else {
      this.mode = Tree.FILEMODE().BLOB
    }
  }
  async getBuffer() {
    if (this.leaf) {
      return (await this.leaf.getBlob()).content()
    }
  }
  exists() {
    return !!this.leaf
  }
  setContent(buffer) {
    if (typeof buffer === 'string') {
      buffer = Buffer.from(buffer, 'utf8')
    }
    if (!(buffer instanceof Buffer)) {
      throw new Error(
        'setContent got something that was not a Buffer or String'
      )
    }
    if (!this.allowUpdate && this.leaf) {
      throw new Error(`Refusing to overwrite ${this.path}`)
    }
    this.leaf = this.tree.insert(this.name, buffer, this.mode)
  }
  delete() {
    if (!this.leaf) {
      throw new Error(`No such file ${this.path}`)
    }
    this.tree.delete(this.name)
    this.leaf = undefined
  }
  savedId() {
    // this is available only after our change has been finalized
    return this.leaf && this.leaf.id()
  }
}
module.exports = Change
async function headCommit(repo, targetBranch, isRemote) {
  let headRef
  try {
    if (isRemote) {
      headRef = await repo.lookupRemoteBranch('origin', targetBranch)
    } else {
      headRef = await repo.lookupLocalBranch(targetBranch)
    }
  } catch (err) {
    if (err.constructor !== git_1.BranchNotFound) {
      throw err
    }
  }
  if (headRef) {
    return await git_1.Commit.lookup(repo, headRef.target())
  }
}
