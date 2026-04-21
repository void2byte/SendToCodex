'use strict';

const fs = require('fs');
const path = require('path');
const {
  deleteFileIfExists,
  ensureDirectory,
  listFilePaths,
  readTextFileIfExists,
  writeTextFile
} = require('../files/fileSystem');

const MANIFEST_FILE_NAME = 'terminal-selection-pairs.json';
const SELECTION_FILE_PATTERN = /^terminal-\d+-.*\.selection-\d+\.(?:md|txt)$/i;
const SNAPSHOT_LINE_PATTERN = /^Snapshot:\s*(.+)$/im;

class SelectionPairRetentionStore {
  constructor(output, logger) {
    this.output = output;
    this.logger = logger;
    this.logDirectory = '';
    this.manifestPath = '';
    this.maxPairs = 50;
    this.entries = [];
  }

  async reload(logDirectory, maxPairs) {
    this.logDirectory = logDirectory || '';
    this.manifestPath = this.logDirectory
      ? path.join(this.logDirectory, MANIFEST_FILE_NAME)
      : '';
    this.maxPairs = normalizeRetentionCount(maxPairs);
    this.entries = [];

    if (!this.logDirectory) {
      return;
    }

    await ensureDirectory(this.logDirectory);
    this.entries = await this.loadManifestEntries();
    await this.mergeDiscoveredSelectionFiles();
    await this.pruneToLimit();
    await this.saveManifest();
  }

  getRetainedFilePaths() {
    const filePaths = new Set();

    for (const entry of this.entries) {
      if (entry.selectionFilePath) {
        filePaths.add(entry.selectionFilePath);
      }
      if (entry.snapshotFilePath) {
        filePaths.add(entry.snapshotFilePath);
      }
    }

    return filePaths;
  }

  async recordPair(selectionFilePath, snapshotFilePath) {
    if (!this.logDirectory || !selectionFilePath) {
      return;
    }

    const now = Date.now();
    const normalizedSelectionPath = path.normalize(selectionFilePath);
    const normalizedSnapshotPath = snapshotFilePath ? path.normalize(snapshotFilePath) : '';
    this.entries = this.entries.filter(
      (entry) => path.normalize(entry.selectionFilePath) !== normalizedSelectionPath
    );
    this.entries.push({
      createdAt: new Date(now).toISOString(),
      createdAtMs: now,
      selectionFilePath: normalizedSelectionPath,
      snapshotFilePath: normalizedSnapshotPath
    });

    await this.pruneToLimit();
    await this.saveManifest();
  }

  async loadManifestEntries() {
    if (!this.manifestPath) {
      return [];
    }

    try {
      const text = await readTextFileIfExists(this.manifestPath);
      if (!text.trim()) {
        return [];
      }

      const parsed = JSON.parse(text);
      const entries = Array.isArray(parsed && parsed.entries) ? parsed.entries : [];
      return entries
        .map((entry, index) => normalizeManifestEntry(entry, index))
        .filter((entry) => entry && isPathInsideDirectory(this.logDirectory, entry.selectionFilePath));
    } catch (error) {
      this.output &&
        this.output.appendLine(
          `Failed to read terminal selection retention manifest: ${error.message}`
        );
      return [];
    }
  }

  async mergeDiscoveredSelectionFiles() {
    const filePaths = await listFilePaths(this.logDirectory);
    const knownSelectionPaths = new Set(
      this.entries.map((entry) => path.normalize(entry.selectionFilePath))
    );
    const discoveredEntries = [];

    for (const filePath of filePaths) {
      if (!SELECTION_FILE_PATTERN.test(path.basename(filePath))) {
        continue;
      }

      const normalizedFilePath = path.normalize(filePath);
      if (knownSelectionPaths.has(normalizedFilePath)) {
        continue;
      }

      const stats = await statFileIfExists(filePath);
      const snapshotFilePath = await readSnapshotPathFromSelectionFile(filePath);
      discoveredEntries.push({
        createdAt: new Date(stats ? stats.mtimeMs : Date.now()).toISOString(),
        createdAtMs: stats ? stats.mtimeMs : Date.now(),
        selectionFilePath: normalizedFilePath,
        snapshotFilePath
      });
    }

    if (discoveredEntries.length) {
      this.entries.push(...discoveredEntries);
      this.logger &&
        this.logger.info('Discovered retained terminal selection files.', {
          count: discoveredEntries.length
        });
    }
  }

  async pruneToLimit() {
    const existingEntries = [];

    for (const entry of this.entries) {
      if (await fileExists(entry.selectionFilePath)) {
        existingEntries.push(entry);
      }
    }

    existingEntries.sort((left, right) => right.createdAtMs - left.createdAtMs);
    const retainedEntries = existingEntries.slice(0, this.maxPairs);
    const prunedEntries = existingEntries.slice(this.maxPairs);
    const retainedSnapshotPaths = new Set(
      retainedEntries
        .map((entry) => entry.snapshotFilePath)
        .filter(Boolean)
        .map((filePath) => path.normalize(filePath))
    );

    for (const entry of prunedEntries) {
      await this.deleteRetainedFile(entry.selectionFilePath);
      if (
        entry.snapshotFilePath &&
        !retainedSnapshotPaths.has(path.normalize(entry.snapshotFilePath))
      ) {
        await this.deleteRetainedFile(entry.snapshotFilePath);
      }
    }

    this.entries = retainedEntries.map((entry) => ({
      createdAt: entry.createdAt,
      createdAtMs: entry.createdAtMs,
      selectionFilePath: entry.selectionFilePath,
      snapshotFilePath: entry.snapshotFilePath
    }));
  }

  async deleteRetainedFile(filePath) {
    if (!filePath || !isPathInsideDirectory(this.logDirectory, filePath)) {
      return;
    }

    try {
      await deleteFileIfExists(filePath);
    } catch (error) {
      this.output && this.output.appendLine(`Failed to delete ${filePath}: ${error.message}`);
    }
  }

  async saveManifest() {
    if (!this.manifestPath) {
      return;
    }

    const entries = this.entries.map((entry) => ({
      createdAt: entry.createdAt,
      selectionFilePath: entry.selectionFilePath,
      snapshotFilePath: entry.snapshotFilePath
    }));

    await writeTextFile(
      this.manifestPath,
      JSON.stringify(
        {
          version: 1,
          maxPairs: this.maxPairs,
          entries
        },
        null,
        2
      )
    );
  }
}

function normalizeRetentionCount(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0
    ? Math.min(1000, Math.round(numberValue))
    : 50;
}

function normalizeManifestEntry(entry, index) {
  if (!entry || typeof entry.selectionFilePath !== 'string' || !entry.selectionFilePath.trim()) {
    return null;
  }

  const createdAtMs = Date.parse(entry.createdAt || '');
  const fallbackTime = Date.now() - index;
  const timestamp = Number.isFinite(createdAtMs) ? createdAtMs : fallbackTime;

  return {
    createdAt: new Date(timestamp).toISOString(),
    createdAtMs: timestamp,
    selectionFilePath: path.normalize(entry.selectionFilePath),
    snapshotFilePath:
      typeof entry.snapshotFilePath === 'string' && entry.snapshotFilePath.trim()
        ? path.normalize(entry.snapshotFilePath)
        : ''
  };
}

async function readSnapshotPathFromSelectionFile(filePath) {
  try {
    const text = await readTextFileIfExists(filePath);
    const match = SNAPSHOT_LINE_PATTERN.exec(text);
    const snapshotPath = match ? match[1].trim() : '';
    if (!snapshotPath || /^unavailable$/i.test(snapshotPath)) {
      return '';
    }

    return path.normalize(snapshotPath);
  } catch {
    return '';
  }
}

async function fileExists(filePath) {
  if (!filePath) {
    return false;
  }

  try {
    const stats = await fs.promises.stat(filePath);
    return stats.isFile();
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

async function statFileIfExists(filePath) {
  try {
    return await fs.promises.stat(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

function isPathInsideDirectory(directoryPath, filePath) {
  const relativePath = path.relative(directoryPath, filePath);
  return Boolean(relativePath) && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

module.exports = {
  SelectionPairRetentionStore
};
