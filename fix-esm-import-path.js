#!/usr/bin/env node
import fs from 'fs'
import path from 'path'
import debug from 'debug'

let processImportType = true
let entryPoints = []
let missingFiles = []

for (let i = 2; i < process.argv.length; i++) {
  let arg = process.argv[i]
  if (arg === '--preserve-import-type') {
    processImportType = false
    continue
  }
  if (arg === '--process-import-type') {
    processImportType = true
    continue
  }
  let entryPoint = arg
  if (fs.existsSync(entryPoint)) {
    entryPoints.push(entryPoint)
  } else {
    missingFiles.push(entryPoint)
  }
}

if (missingFiles.length > 0) {
  let name = missingFiles.map(name => JSON.stringify(name)).join(', ')
  console.error(`entryPoint ${name} does not exist`)
  process.exit(1)
}

if (entryPoints.length === 0) {
  console.error('missing entryPoint in argument')
  process.exit(1)
}

let log = debug('fix-esm-import-path')
// log.enabled = true

function findNodeModuleDir(srcFile, name) {
  let dir = path.dirname(srcFile)
  for (;;) {
    let files = fs.readdirSync(dir)
    if (files.includes('node_modules')) {
      let moduleDir = path.join(dir, 'node_modules', name)
      if (fs.existsSync(moduleDir)) {
        return moduleDir
      }
    }
    dir = path.join(dir, '..')
    if (path.resolve(dir) === '/') {
      return null
    }
  }
}

function getModuleEntryFile(dir) {
  let entryFile = 'index.js'
  let files = fs.readdirSync(dir)
  if (files.includes('package.json')) {
    let text = fs.readFileSync(path.join(dir, 'package.json')).toString()
    let pkg = JSON.parse(text)
    entryFile = pkg.module || pkg.main || entryFile
  }
  return path.join(dir, entryFile)
}

function fixImport({ srcFile, importCode, from, to }) {
  let newImportCode = importCode.replace(from, to)
  log(`[fixImport]`, { srcFile, importCode, from, to })
  let code = fs.readFileSync(srcFile).toString()
  code = code.replace(importCode, newImportCode)
  fs.writeFileSync(srcFile, code)
  return newImportCode
}

function scanModuleMainFile({ file }) {
  // no need?
  // log(`[scanModuleMainFile] TODO`, { file })
}

function scanModule({ srcFile, importCode, name }) {
  let numOfDirInName = name.split('/').length - 1
  if (name.includes('@')) {
    numOfDirInName--
  }
  if (numOfDirInName == 0) {
    return
  }
  let dir = findNodeModuleDir(srcFile, name)
  if (dir) {
    let mainFile = isFileExists(dir) ? dir : getModuleEntryFile(dir)
    return scanModuleMainFile({ file: mainFile })
  }

  let jsName = name + '.js'
  let jsFile = findNodeModuleDir(srcFile, jsName)
  if (!jsFile) {
    console.error(`Error: cannot resolve module`, {
      name,
      srcFile,
      importCode,
    })
    process.exit(1)
  }
  fixImport({ srcFile, importCode, from: name, to: jsName })
  scanModuleMainFile({ file: jsFile })
}

function resolveImportName({ srcFile, name }) {
  if (name.startsWith('/')) {
    return { type: 'absolute', name }
  }
  if (name.startsWith('./')) {
    let dir = path.dirname(srcFile)
    name = path.join(dir, name)
    return { type: 'relative', name }
  }
  if (name.startsWith('../')) {
    let dir = path.dirname(srcFile)
    name = path.join(dir, name)
    return { type: 'relative', name }
  }
  return { type: 'module', name }
}

function scanImport({ srcFile, importCode, name }) {
  let { type, name: importName } = resolveImportName({ srcFile, name })
  if (type == 'module') {
    return scanModule({ srcFile, importCode, name })
  }
  let importFile = resolveImportFile(importName)
  if (!importFile) {
    console.error(`[scanImport] File not found:`, {
      srcFile,
      importName,
      importCode,
      name,
    })
    process.exit(1)
  }
  let ext_list = ['.js', '.jsx', '.ts', 'tsx']
  if (
    !importFile.startsWith(importName + '/index') &&
    !ext_list.some(ext => importName.endsWith(ext))
  ) {
    for (let ext of ext_list) {
      if (!importName.endsWith('.js') && importFile.endsWith(ext)) {
        log(`[scanImport] fix import:`, {
          srcFile,
          importCode,
          importName,
          importFile,
        })
        importCode = fixImport({
          srcFile,
          importCode,
          from: name,
          to: name + '.js',
        })
        break
      }
    }
  }
  return scanFile({ srcFile: importFile })
}

function isFileExists(file) {
  return fs.existsSync(file) && fs.statSync(file).isFile()
}

function resolveImportFile(file) {
  if (isFileExists(file)) {
    return file
  }
  for (let jsExt of ['.js', '.jsx']) {
    let jsFile = file + jsExt
    if (isFileExists(jsFile)) {
      return jsFile
    }
    for (let tsExt of ['.ts', '.tsx']) {
      let tsFile = file + tsExt
      if (isFileExists(tsFile)) {
        return tsFile
      }
      if (file.endsWith(jsExt)) {
        tsFile = file.slice(0, file.length - jsExt.length) + tsExt
        if (isFileExists(tsFile)) {
          return tsFile
        }
      }
    }
  }

  for (let indexFile of ['index.js', 'index.jsx', 'index.ts', 'index.tsx']) {
    indexFile = path.join(file, indexFile)
    if (isFileExists(indexFile)) {
      return indexFile
    }
  }
  return null
}

let visit_file_set = new Set()
function scanFile({ srcFile }) {
  if (visit_file_set.has(srcFile)) return
  visit_file_set.add(srcFile)
  log('[scanFile]', { srcFile })
  let code = fs.readFileSync(srcFile).toString()
  for (let regex of [
    /.*import .* from '(.*)'.*/g,
    /.*import .* from "(.*)".*/g,
    /.*export .* from '(.*)'.*/g,
    /.*export .* from "(.*)".*/g,
  ]) {
    for (let match of code.matchAll(regex)) {
      let [importCode, name] = match
      if (!processImportType && importCode.includes('import type')) continue
      scanImport({ srcFile, importCode, name })
    }
  }
}

function scanEntryPoint(file) {
  log('[scanEntryPoint]', { file })
  let stat = fs.statSync(file)
  if (stat.isFile()) {
    if (file.endsWith('.js') || file.endsWith('.ts')) {
      scanFile({ srcFile: file })
    }
    // e.g. package.json, .gitignore
    return
  }
  if (stat.isDirectory()) {
    fs.readdirSync(file).forEach(filename => {
      if (filename == 'node_modules') return
      scanEntryPoint(path.join(file, filename))
    })
    return
  }
  // e.g. socket file
  console.log('skip unsupported file:', file)
}

for (let entryPoint of entryPoints) {
  scanEntryPoint(entryPoint)
}

console.log('done.')
