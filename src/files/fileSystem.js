'use strict';

const fs = require('fs');
const path = require('path');

const UTF8_BOM = '\uFEFF';

async function ensureDirectory(directoryPath) {
  await fs.promises.mkdir(directoryPath, { recursive: true });
}

async function ensureDirectoryForFile(filePath) {
  await ensureDirectory(path.dirname(filePath));
}

async function readTextFileIfExists(filePath) {
  try {
    return stripUtf8Bom(await fs.promises.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return '';
    }

    throw error;
  }
}

async function writeTextFile(filePath, contents) {
  await ensureDirectoryForFile(filePath);
  await fs.promises.writeFile(filePath, encodeUtf8WithBom(contents), 'utf8');
}

async function appendTextFile(filePath, contents) {
  await ensureDirectoryForFile(filePath);
  const text = String(contents || '');

  try {
    const stats = await fs.promises.stat(filePath);
    if (stats.size > 0) {
      await fs.promises.appendFile(filePath, text, 'utf8');
      return;
    }
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      throw error;
    }
  }

  await fs.promises.writeFile(filePath, encodeUtf8WithBom(text), 'utf8');
}

async function deleteFileIfExists(filePath) {
  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return;
    }

    throw error;
  }
}

function fileExistsSync(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

async function listFilePaths(directoryPath) {
  try {
    const entries = await fs.promises.readdir(directoryPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(directoryPath, entry.name));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

function stripUtf8Bom(value) {
  return String(value || '').replace(/^\uFEFF/, '');
}

function encodeUtf8WithBom(value) {
  const text = stripUtf8Bom(value);
  return `${UTF8_BOM}${text}`;
}

module.exports = {
  appendTextFile,
  deleteFileIfExists,
  ensureDirectory,
  ensureDirectoryForFile,
  fileExistsSync,
  listFilePaths,
  readTextFileIfExists,
  writeTextFile
};
