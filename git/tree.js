'use strict'
Object.defineProperty(exports, '__esModule', {
  value: true
})
exports.OverwriteRejected = exports.FileNotFound = exports.TreeEntry = void 0
const git_1 = require('../git')
const fs = require('fs')
const isomorphic_git_1 = require('isomorphic-git')
const path_1 = require('path')
const mutex = require('../git_mutex')
class Tree {
  constructor(repo, containingEntry, readResult) {
    this.repo = repo
    this.containingEntry = containingEntry
    this.dirty = false
    if (readResult) {
      this._entries = readResult.tree.map(e => TreeEntry.build(repo, this, e))
      this.oid = new git_1.Oid(readResult.oid)
    } else {
      this.dirty = true
      this._entries = []
    }
  }
  static async lookup(repo, oid, containingEntry) {
    const release = await mutex.acquire()
    let readResult
    try {
      readResult = await isomorphic_git_1.readTree({
        fs,
        gitdir: repo.gitdir,
        oid: oid.sha
      })
    } finally {
      release()
    }
    return new Tree(repo, containingEntry, readResult)
  }
  static create(repo, containingEntry) {
    return new Tree(repo, containingEntry)
  }
  static FILEMODE() {
    return {
      TREE: '040000',
      BLOB: '100644',
      EXECUTABLE: '100755',
      LINK: '120000',
      COMMIT: '160000'
    }
  }
  id() {
    return this.oid
  }
  entries() {
    return this._entries
  }
  entryByName(name) {
    return this._entries.find(e => e.name() === name)
  }
  insert(name, contents, filemode) {
    this.removeEntryByName(name)
    let entry = TreeEntry.create(this.repo, this, name, contents, filemode)
    this._entries.push(entry)
    this.makeDirty()
    return entry
  }
  removeEntryByName(name) {
    this._entries = this._entries.filter(e => e.name() !== name)
    this.makeDirty()
  }
  makeDirty() {
    this.dirty = true
    if (this.containingEntry) {
      this.containingEntry.makeDirty()
    }
  }
  async delete(name) {
    this.removeEntryByName(name)
  }
  async fileAtPath(path, allowCreate) {
    let tombstone
    let { tree, leaf, leafName } = await this.traverse(path, allowCreate)
    if (!leaf || leaf === tombstone || !leaf.isBlob()) {
      leaf = undefined
    }
    if (!leaf && !allowCreate) {
      throw new FileNotFound(`No such file ${path}`)
    }
    return {
      tree,
      leaf,
      leafName
    }
  }
  async traverse(path, allowCreate = false) {
    let parts = path.split('/')
    let here = this
    while (parts.length > 1) {
      let dirName = parts.shift()
      let entry = here.entryByName(dirName)
      if (!entry || !entry.isTree()) {
        if (!allowCreate) {
          throw new FileNotFound(`${path} does not exist`)
        }
        entry = here.insert(
          dirName,
          Tree.create(here.repo, entry),
          '040000' /* TREE */
        )
      }
      here = await entry.getTree()
    }
    return {
      tree: here,
      leaf: here.entryByName(parts[0]),
      leafName: parts[0]
    }
  }
  path() {
    if (this.containingEntry) {
      return this.containingEntry.path()
    } else {
      return ''
    }
  }
  async write(allowEmpty = false) {
    if (!this.dirty) {
      return this.id()
    }
    for (let entry of this.entries()) {
      await entry.write()
    }
    if (this.entries().length || allowEmpty) {
      const release = await mutex.acquire()
      let sha
      try {
        sha = await isomorphic_git_1.writeTree({
          fs,
          gitdir: this.repo.gitdir,
          tree: this.entries().map(e => e.toTreeObject())
        })
      } finally {
        release()
      }
      this.oid = new git_1.Oid(sha)
      this.dirty = false
      return this.id()
    } else if (this.containingEntry) {
      this.containingEntry.removeFromParent()
    }
  }
}
exports.default = Tree
exports.Tree = Tree
class TreeEntry {
  constructor(repo, tree, entry, _name, contents, _filemode) {
    this.repo = repo
    this.tree = tree
    this.entry = entry
    this._name = _name
    this.contents = contents
    this._filemode = _filemode
    if (this.entry) {
      this.dirty = false
      this.oid = new git_1.Oid(this.entry.oid)
    } else {
      this.dirty = true
    }
  }
  static create(repo, tree, name, contents, filemode) {
    return new TreeEntry(repo, tree, undefined, name, contents, filemode)
  }
  static build(repo, tree, entry) {
    return new TreeEntry(repo, tree, entry)
  }
  name() {
    return this._name || this.entry.path
  }
  path() {
    return path_1.join(this.tree.path(), this.name())
  }
  id() {
    return this.oid || null
  }
  isTree() {
    return (
      this.contents instanceof Tree || (this.entry && this.entry.type == 'tree')
    )
  }
  isBlob() {
    return (
      this.contents instanceof Buffer ||
      (this.entry && this.entry.type == 'blob')
    )
  }
  filemode() {
    return this._filemode || this.entry.mode
  }
  async write() {
    if (this.isTree()) {
      let tree = await this.getTree()
      this.oid = await tree.write()
      // this.tree.insert(this.name(), tree, FILEMODE.TREE);
      this.dirty = false
      return
    }
    if (!this.dirty) {
      return
    }
    const release = await mutex.acquire()
    let sha
    try {
      sha = await isomorphic_git_1.writeBlob({
        fs,
        gitdir: this.repo.gitdir,
        blob: this.contents
      })
    } finally {
      release()
    }
    this.oid = new git_1.Oid(sha)
    this.dirty = false
  }
  async getTree() {
    if (this.isTree() && this.contents) {
      return this.contents
    }
    let tree = await Tree.lookup(this.repo, this.id(), this)
    this.contents = tree
    return tree
  }
  makeDirty() {
    this.dirty = true
    this.tree.makeDirty()
  }
  toTreeObject() {
    return {
      mode: this.filemode(),
      path: this.name(),
      type: this.isBlob() ? 'blob' : 'tree',
      oid: this.oid.sha
    }
  }
  removeFromParent() {
    this.tree.delete(this.name())
  }
  async getBlob() {
    if (this.contents) {
      let content = this.contents
      return {
        id: null,
        content() {
          return content
        }
      }
    }
    let blob
    const release = await mutex.acquire()
    try {
      let obj = await isomorphic_git_1.readBlob({
        fs,
        gitdir: this.repo.gitdir,
        oid: this.entry.oid
      })
      blob = obj.blob
    } finally {
      release()
    }
    return {
      id: this.id(),
      content() {
        return blob
      }
    }
  }
}
exports.TreeEntry = TreeEntry
class FileNotFound extends Error { }
exports.FileNotFound = FileNotFound
class OverwriteRejected extends Error { }
exports.OverwriteRejected = OverwriteRejected
