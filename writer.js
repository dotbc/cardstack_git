'use strict'
Object.defineProperty(exports, '__esModule', {
  value: true
})
const git_1 = require('./git')
const tree_1 = require('./git/tree')
const crypto_1 = require('crypto')
const change_1 = require('./change')
const os_1 = require('os')
const process_1 = require('process')
const util_1 = require('util')
const temp_1 = require('temp')
temp_1.track()
const lodash_1 = require('lodash')
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const Githereum = require('githereum/githereum')
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const GithereumContract = require('githereum/build/contracts/Githereum.json')
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const TruffleContract = require('truffle-contract')
const debounce = require('debounce-promise');
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const isInternalCard = (type = '', id = '') => {
  const cardIdDelim = '::'
  return id && type === id && id.split(cardIdDelim).length > 1
}
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const stringify = require('json-stable-stringify-without-jsonify')
const logger_1 = require('@cardstack/logger')
const log = logger_1('cardstack/git')
const mkdir = util_1.promisify(temp_1.mkdir)
const defaultBranch = 'master'

function getType(model) {
  return model.data ? model.data.type : model.type
}

function getId(model) {
  return model.data ? model.data.id : model.id
}

function getMeta(model) {
  return model.data ? model.data.meta : model.meta
}
class Writer {
  constructor({
    repo,
    idGenerator,
    basePath,
    branchPrefix,
    remote,
    githereum
  }) {
    this.repoPath = repo
    this.basePath = basePath
    this.branchPrefix = branchPrefix || ''
    let hostname = os_1.hostname()
    this.myName = `PID${process_1.pid} on ${hostname}`
    this.myEmail = `${os_1.userInfo().username}@${hostname}`
    this.idGenerator = idGenerator
    this.remote = remote
    this.softWrite = false
    if (githereum) {
      let config = Object.assign({}, githereum)
      config.log = log.info.bind(log)
      this.githereumConfig = config
    }
  }
  static create(params) {
    return new this(params)
  }
  get hasCardSupport() {
    return true
  }
  async bulkPush() {
    await this._ensureRepo()
    await this.repo.fetchAll()
    const targetBranch = this.branchPrefix + defaultBranch
    await this.repo.mergeBranches(targetBranch, `origin/${targetBranch}`)
  }
  async prepareCreate(session, type, document, isSchema, softWrite) {
    let id = getId(document)
    if (typeof softWrite !== 'undefined') {
      this.softWrite = softWrite
    }
    return withErrorHandling(id, type, async () => {
      await this._ensureRepo()
      let type = getType(document)
      let change = await change_1.create(
        this.repo,
        null,
        this.branchPrefix + defaultBranch,
        !!this.remote
      )
      let file
      while (id == null) {
        let candidateId = this._generateId()
        let candidateFile = await change.get(
          this._filenameFor(type, candidateId, isSchema),
          {
            allowCreate: true
          }
        )
        if (!candidateFile.exists()) {
          id = candidateId
          file = candidateFile
        }
      }
      if (!file) {
        file = await change.get(this._filenameFor(type, id, isSchema), {
          allowCreate: true
        })
      }
      let gitDocument =
        document.data && isInternalCard(type, id)
          ? {
            data: {
              id,
              type
            }
          }
          : {
            id,
            type
          }
      if (document.data && isInternalCard(type, id)) {
        gitDocument = lodash_1.merge(gitDocument, lodash_1.cloneDeep(document))
      } else {
        if (document.attributes) {
          gitDocument.attributes = document.attributes
        }
        if (document.relationships) {
          gitDocument.relationships = document.relationships
        }
      }
      let signature = await this._commitOptions('create', type, id, session)
      return {
        finalDocument: gitDocument,
        finalizer: finalizer.bind(this),
        type,
        id,
        signature,
        change,
        file
      }
    })
  }
  async prepareUpdate(session, type, id, document, isSchema, softWrite) {
    let meta = getMeta(document)
    if (typeof softWrite !== 'undefined') {
      this.softWrite = softWrite
    }
    if (!meta || !meta.version) {
      throw new Error('missing required field "meta.version"')
    }
    await this._ensureRepo()
    return withErrorHandling(id, type, async () => {
      let change = await change_1.create(
        this.repo,
        meta.version,
        this.branchPrefix + defaultBranch,
        !!this.remote
      )
      let file = await change.get(this._filenameFor(type, id, isSchema), {
        allowUpdate: true
      })
      const data = Buffer.from(await file.getBuffer()).toString('utf8')
      try {
        let before = JSON.parse(data)
        let after = patch(before, document)
        // we don't write id & type into the actual file (they're part
        // of the filename). But we want them present on the
        // PendingChange as complete valid documents.
        if (!isInternalCard(type, id)) {
          before.id = id
          before.type = type
          after.id = document.id
          after.type = document.type
        }
        let signature = await this._commitOptions('update', type, id, session)
        return {
          originalDocument: before,
          finalDocument: after,
          finalizer: finalizer.bind(this),
          type,
          id,
          signature,
          change,
          file
        }
      } catch (e) {
        console.log(e, 'JSON', data)
      }
    })
  }
  async prepareDelete(session, version, type, id, isSchema) {
    if (!version) {
      throw new Error('version is required')
    }
    await this._ensureRepo()
    return withErrorHandling(id, type, async () => {
      let change = await change_1.create(
        this.repo,
        version,
        this.branchPrefix + defaultBranch,
        !!this.remote
      )
      let file = await change.get(this._filenameFor(type, id, isSchema))
      let before = JSON.parse(
        Buffer.from(await file.getBuffer()).toString('utf8')
      )
      file.delete()
      before.id = id
      before.type = type
      let signature = await this._commitOptions('delete', type, id, session)
      return {
        originalDocument: before,
        finalizer: finalizer.bind(this),
        type,
        id,
        signature,
        change
      }
    })
  }
  async _commitOptions(operation, type, id, session) {
    let user = session && (await session.loadUser())
    let userAttributes = (user && user.data && user.data.attributes) || {}
    return {
      authorName:
        userAttributes['full-name'] ||
        userAttributes.name ||
        'Anonymous Coward',
      authorEmail: userAttributes.email || 'anon@example.com',
      committerName: this.myName,
      committerEmail: this.myEmail,
      message: `${operation} ${type} ${String(id).slice(12)}`
    }
  }
  _filenameFor(type, id, isSchema) {
    let base = this.basePath ? this.basePath + '/' : ''
    if (!isSchema && isInternalCard(type, id)) {
      return `${base}cards/${id}.json`
    }
    let category = isSchema ? 'schema' : 'contents'
    return `${base}${category}/${type}/${id}.json`
  }
  async _ensureRepo() {
    if (!this.repo) {
      if (this.remote) {
        // @ts-ignore promisify not typed well apparently?
        let tempRepoPath = await mkdir('cardstack-temp-repo')
        this.repo = await git_1.Repository.clone(this.remote.url, tempRepoPath)
        return
      }
      this.repo = await git_1.Repository.open(this.repoPath)
    }
  }
  async _ensureGithereum() {
    await this._ensureRepo()
    if (!this.githereum && this.githereumConfig) {
      let contract = await this._getGithereumContract()
      this.githereum = new Githereum(
        this.repo.path,
        this.githereumConfig.repoName,
        contract,
        this.githereumConfig.from,
        {
          log: log.info.bind(log)
        }
      )
    }
  }
  async _getGithereumContract() {
    let providerUrl =
      this.githereumConfig.providerUrl || 'http://localhost:9545'
    let GithereumTruffleContract = TruffleContract(GithereumContract)
    GithereumTruffleContract.setProvider(providerUrl)
    return await GithereumTruffleContract.at(
      this.githereumConfig.contractAddress
    )
  }
  _generateId() {
    if (this.idGenerator) {
      return this.idGenerator()
    } else {
      // 20 bytes is good enough for git, so it's good enough for
      // me. In practice we probably have a lower collision
      // probability too, because we're allowed to retry if we know
      // the id is already in use (so we can really only collide
      // with things that have not yet merged into our branch).
      return crypto_1.randomBytes(20).toString('hex')
    }
  }
  async _pushToGithereum() {
    await this._ensureGithereum()
    if (this.githereum) {
      log.info('Githereum is enabled, triggering push')
      log.info('Starting githereum push')
      if (!this._githereumPushDebounced) {
        this._githereumPushDebounced = debounce(() => {
          log.info("Starting githereum push");
          return this.githereum.push(this.githereumConfig.tag).then(() =>
            log.info("Githereum push complete")
          ).catch(e => {
            log.error("Error pushing to githereum:", e, e.stack);
          });

        }, this.githereumConfig.debounce || 0);
      }

      this._githereumPushDebounced();
    } else {
      log.info('Githereum is disabled')
    }
  }
}
exports.default = Writer
// TODO: we only need to do this here because the Hub has no generic
// "read" hook to call on writers. We should use that instead and move
// this into the generic hub:writers code.
function patch(before, diffDocument) {
  let after
  let afterResource
  let beforeResource
  let diffDocumentResource
  if (
    diffDocument.data &&
    isInternalCard(diffDocument.data.type, diffDocument.data.id)
  ) {
    after = {
      data: Object.assign({}, before.data),
      included: []
    }
    if (Array.isArray(diffDocument.included)) {
      after.included = [].concat(diffDocument.included)
    }
    afterResource = after.data
    beforeResource = before.data
    diffDocumentResource = diffDocument.data
  } else {
    after = Object.assign({}, before)
    afterResource = after
    beforeResource = before
    diffDocumentResource = diffDocument
  }
  for (let section of ['attributes', 'relationships']) {
    if (diffDocumentResource[section]) {
      afterResource[section] = Object.assign(
        {},
        beforeResource[section],
        diffDocumentResource[section]
      )
    }
  }
  return after
}
async function withErrorHandling(id, type, fn) {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof git_1.UnknownObjectId) {
      throw new Error(err.message)
    }
    if (err instanceof git_1.GitConflict) {
      throw new Error('Merge conflict')
    }
    if (err instanceof tree_1.OverwriteRejected) {
      throw new Error(`id ${id} is already in use for type ${type}`)
    }
    if (err instanceof tree_1.FileNotFound) {
      throw new Error(`${type} with id ${id} does not exist`)
    }
    throw err
  }
}
async function finalizer(pendingChange) {
  let { id, type, change, file, signature } = pendingChange
  return withErrorHandling(id, type, async () => {
    if (file) {
      if (pendingChange.finalDocument) {
        // use stringify library instead of JSON.stringify, since JSON's method
        // is non-deterministic and could produce unnecessary diffs
        if (pendingChange.finalDocument.data && isInternalCard(type, id)) {
          file.setContent(stringify(pendingChange.finalDocument, null, 2))
        } else {
          file.setContent(
            stringify(
              {
                attributes: pendingChange.finalDocument.attributes,
                relationships: pendingChange.finalDocument.relationships
              },
              null,
              2
            )
          )
        }
      } else {
        file.delete()
      }
    }
    let version = await change.finalize(signature, this.remote)
    if (this.softWrite) {
      this._pushToGithereum().catch(e => console.log(e))
    } else {
      await this._pushToGithereum()
    }
    return {
      version,
      hash: file ? file.savedId() : null
    }
  })
}
module.exports = Writer
