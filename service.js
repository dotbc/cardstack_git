"use strict";
Object.defineProperty(exports, "__esModule", {
  value: true
});
const git_1 = require("./git");
const util_1 = require("util");
const mkdirp_1 = require("mkdirp");
const mkdirp = util_1.promisify(mkdirp_1);
const filenamify_url_1 = require("filenamify-url");
const fs_1 = require("fs");
const rimraf_1 = require("rimraf");
const rimraf = util_1.promisify(rimraf_1);
const path_1 = require("path");
const os_1 = require("os");
const logger_1 = require("@cardstack/logger");
const log = logger_1('cardstack/git');
class GitLocalCache {
  constructor() {
    this._remotes = new Map();
  }
  clearCache() {
    this._remotes = new Map();
  }
  async getRepo(remoteUrl, remote) {
    let existingRepo = this._remotes.get(remoteUrl);
    if (existingRepo) {
      log.info('existing repo found for %s, reusing it from the cache', remoteUrl);
      return existingRepo.repo;
    }
    let {
      repo,
      repoPath
    } = await this._makeRepo(remote);
    this._remotes.set(remote.url, {
      repo,
      repoPath,
    });
    return repo;
  }
  async _makeRepo(remote) {
    let cacheDirectory = remote.cacheDir;
    if (!cacheDirectory) {
      cacheDirectory = path_1.join(os_1.tmpdir(), 'cardstack-git-local-cache');
      if (!fs_1.existsSync(cacheDirectory)) {
        await mkdirp(cacheDirectory);
      }
    }
    let repoPath = path_1.join(cacheDirectory, filenamify_url_1(remote.url));
    log.info('creating local repo cache for %s in %s', remote.url, repoPath);
    let repo;
    if (fs_1.existsSync(repoPath)) {
      try {
        log.info('repo already exists - reusing local clone');
        repo = await git_1.Repository.open(repoPath);
      } catch (e) {
        log.info('creating repo from %s failed, deleting and recloning', repoPath);
        // if opening existing repo fails for any reason we should just delete it and clone it
        await rimraf(repoPath);
        await mkdirp(repoPath);
        repo = await git_1.Repository.clone(remote.url, repoPath);
      }
    } else {
      log.info('cloning %s into %s', remote.url, repoPath);
      await mkdirp(repoPath);
      repo = await git_1.Repository.clone(remote.url, repoPath);
    }
    return {
      repo,
      repoPath,
    };
  }
  async fetchAllFromRemote(remoteUrl) {
    let {
      repo
    } = this._remotes.get(remoteUrl);
    return await repo.fetchAll();
  }
  async pullRepo(remoteUrl, targetBranch) {
    log.info('pulling changes for branch %s on %s', targetBranch, remoteUrl);
    let {
      repo
    } = this._remotes.get(remoteUrl);
    // if branch does not exist locally then create it and reset to head of remote
    // this is required because node git doesn't support direct pull https://github.com/nodegit/nodegit/issues/1123
    try {
      await repo.getReference(`${targetBranch}`);
      log.info('reference for %s on %s already exists, continuing', targetBranch, remoteUrl);
    } catch (e) {
      if (e.message.startsWith('no reference found for shorthand')) {
        log.info('no local branch for %s on %s. Creating it now...', targetBranch, remoteUrl);
        let headCommit = await repo.getHeadCommit();
        let ref = await repo.createBranch(targetBranch, headCommit);
        await repo.checkoutBranch(ref);
        let remoteCommit = await repo.getReferenceCommit(`refs/remotes/origin/${targetBranch}`);
        await repo.reset(remoteCommit, true);
      } else {
        throw e;
      }
    }
    await repo.mergeBranches(targetBranch, `origin/${targetBranch}`);
  }
}
const singleton = new GitLocalCache();
exports.default = singleton;
module.exports = singleton;
