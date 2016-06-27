import fs from 'fs'
import path from 'path'

import validator from 'validator'
import mkdirp from 'mkdirp'
import rimraf from 'rimraf'

import { mkdirAsync, fsReaddirAsync, mapXstatToObject } from './tools'
import { readXstat, readXstatAsync, updateXattrPermissionAsync } from './xstats'
import { Node, MapTree } from './maptree'

const driveDir = (root) => path.join(root, 'drive')
const libraryDir = (root) => path.join(root, 'library')
const updateDir = (root) => path.join(root, 'uploads')
const thumbDir = (root) => path.join(root, 'thumb')
const predefinedDirs = (root) => 
  [ root, driveDir(root), libraryDir(root), uploadDir(root), thumbDir(root) ]


async function initMkdirs(root) {
  let predefined = predefiendDirs(root) 
  for (let i = 0; i < predefined.length; i++) {
    await mkdirpAsync(predefined[i])
  }
}

/*
 * only one owner allowed
 */
const validateDriveOwner = (owner, uuid) =>
  (owner && Array.isArray(owner) && owner.length === 1 && owner[0] === uuid)

const validateLibraryOwner = (owner) =>
  (owner && Array.isArray(owner) && owner.length === 1 && (typeof owner[0] === 'string') && validator.isUUID(owner[0]))
/*
 * not null, is array, uuid valid
 */
const validateUserList = (list) => 
  (list && Array.isArray(list) && list.every(u => typeof u === 'string') && list.every(u => validator.isUUID(u)))


/*
 * drive permission check, return <entry, owner> pair
 */ 
async function checkDriveXstat(drivedir, uuid) {

  let dir = path.join(drivedir, uuid)

  let x = await readXstatAsync(dir)
  if (x instanceof Error) return x
  let { owner, writelist, readlist } = x

  if (validateDriveOwner(owner) &&
      validateUserList(writelist) &&
      validateUserList(readlist)) return null

  let err = await updateXattrPermissionAsync(dir, {
    owner: [uuid],
    writelist: validateUserList(writelist) ? writelist : [],
    readlist: validateUserList(readlist) ? readlist : [] 
  })

  if (err instanceof Error) return err
  return {
    entry: uuid,
    owner: [uuid]
  } 
}

/*
 * library permission check, return <entry, owner> pair
 */
async function checkLibraryXstat(librarydir, uuid) {

  let dir = path.join(librarydir, uuid)  
  let x = await readXstatAsync(dir)
  if (x instanceof Error) return x

  let { owner, writelist, readlist } = x

  // if no owner, TODO may check database
  if (!validateLibraryOwner(owner))
    return new Error(`${dir} owner invalid`)

  // do this anyway
  let err = await updateXattrPermissionAsync(dir, {
    owner, 
    writelist: [], // force clear
    readlist: validateUserList(readlist) ? readlist : []
  })

  if (err instanceof Error) return err
  return {
    entry: uuid,
    owner: owner
  }
}

async function inspectDrives(driveDir) {

  let files = await fsReaddirAsync(driveDir)
  files = files.filter(f => validator.isUUID(f))

  let valid = []
  for (let i = 0; i < files.length; i++) {
    let uuid = files[i]
    let r = await checkDriveXstat(driveDir, uuid)
    if (!(r instanceof Error)) valid.push(r)
  } 
  return valid
}

async function inspectLibraries(librarydir) {

  let files = await fsReaddirAsync(librarydir)
  files = files.filter(f => validator.isUUID(f))

  let valid = []
  for (let i = 0; i < files.length; i++) {
    let uuid = files[i]
    let r = await checkLibraryXstat(librarydir, files[i])
    if (!(r instanceof Error)) valid.push(r)
  }
  return valid
}

const visitor = (dir, dirContext, entry, callback) => {

  let entrypath = path.join(dir, entry)
  readXstat(entrypath, (err, xstat) => {

    if (err) return callback()
    if (!xstat.isDirectory() && !xstat.isFile()) return callback()

    let { tree, node, owner } = dirContext
    let object = mapXstatToObject(xstat)
    let entryNode = tree.createNode(node, object)
    if (!entryNode) return callback()
    if (!xstat.isDirectory()) return callback()  

    // now it's directory
    callback({ tree, node: entryNode, owner })
  })
}

async function dirToNode(dir, tree, parent) {

  let xstat = awaitreadXstatAsync(dir)
  if (xstat instanceof Error) return xstat
  
  let object = mapXstatToObject(xstat)
  if (!tree)
    return new MapTree(object)
  else
    return tree.createNode(parent, object)
}

async function buildTree(root) {

  let promises = [], valid, node, dir, promise
  let tree, driveDirNode, libraryDirNode

  let drivedir = driveDir(root)
  let librarydir = libraryDir(root)

  await initMkdirs(root)

  // build tree root
  tree = dirToNode(root)

  // set driveDir
  driveDirNode = dirToNode(drivedir, tree, tree.root)

  // set drives
  valid = inspectDrives(driveDir(root))
  for (let i = 0; i < valid.length; i++) {
    dir = path.join(drivedir, valid[i].entry)
    node = dirToNode(dir, tree, driveDirNode)
    promise = new Promise(resolve => 
      folderVisit(dir, {tree, node, owner: node.permission.owner}, visitor, () => 
        resolve()))

    promises.push(promise)
  } 

  // set libraryDir 
  libraryDirNode = dirToNode(libraryDir, tree, tree.root) 

  // set libraries
  valid = inspectLibraries(librarydir)
  for (let i = 0; i < valid.length; i++) {

    dir = path.join(librarydir, valid[i].entry)
    node = dirToNode(dir, tree, libraryDirNode)
    promise = new Promise(resolve => 
      folderVisit(dir, {tree, node, owner: node.permission.owner}, visitor, () => 
        resolve()))

    promises.push(promise)
  }

  await Promise.all(promises)
  return {
    root,
    prepend: path.resolve(root, '..'),
    tree, 
    libraryDirNode, 
    driveDirNode
  }
}

export { buildTree }

buildTree('/data/fruitmix')
