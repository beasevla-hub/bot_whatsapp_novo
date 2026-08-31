const fs = require('fs');
const path = require('path');

function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
}

function readJson(filePath, fallback = {}) {
  try {
    return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : fallback;
  } catch (error) {
    return fallback;
  }
}

function acquireProcessLock(lockPath, staleAfterMs = 30 * 60 * 1000) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return () => {
      try { fs.closeSync(fd); } catch (_) {}
      try { fs.unlinkSync(lockPath); } catch (_) {}
    };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    try {
      const stat = fs.statSync(lockPath);
      if (Date.now() - stat.mtimeMs > staleAfterMs) {
        fs.unlinkSync(lockPath);
        return acquireProcessLock(lockPath, staleAfterMs);
      }
    } catch (_) {}
    return null;
  }
}

module.exports = { writeJsonAtomic, readJson, acquireProcessLock };
