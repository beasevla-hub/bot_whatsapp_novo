const fs = require('fs');
const path = require('path');

const TIMEZONE = 'America/Sao_Paulo';

function getTodayString() {
  const now = new Date();
  return now.toLocaleDateString('pt-BR', { timeZone: TIMEZONE }).replace(/\//g, '.');
}

function getDateString(date) {
  return date.toLocaleDateString('pt-BR', { timeZone: TIMEZONE }).replace(/\//g, '.');
}

function getTodayDayNumber() {
  const now = new Date();
  return String(now.getDate()).padStart(2, '0');
}

function getNowTimeString() {
  const now = new Date();
  return now.toLocaleTimeString('pt-BR', { timeZone: TIMEZONE, hour12: false });
}

function formatTimestamp(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString('pt-BR', { timeZone: TIMEZONE, hour12: false });
}

function isToday(ts) {
  if (!ts) return false;
  const msgDate = new Date(ts * 1000).toLocaleDateString('pt-BR', { timeZone: TIMEZONE }).replace(/\//g, '.');
  return msgDate === getTodayString();
}

function isDate(ts, dateStr) {
  if (!ts) return false;
  const msgDate = new Date(ts * 1000).toLocaleDateString('pt-BR', { timeZone: TIMEZONE }).replace(/\//g, '.');
  return msgDate === dateStr;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Extrai o número sequencial do nome da pasta.
 * Ex: "18 - 31.07.2026" → 18
 * Ex: "01 - 09.03.2026" → 1
 * Retorna 0 se não conseguir extrair.
 */
function getDayNumberFromFolder(name) {
  const match = name.match(/^(\d{2})\s*-/);
  if (match) {
    return parseInt(match[1], 10);
  }
  return 0;
}

/**
 * Encontra ou cria a pasta do dia dentro do caminho base da obra.
 * Padrão: "NN - DD.MM.AAAA" onde NN é sequencial (ex: "19 - 04.08.2026")
 * 
 * @param {string} basePath - Caminho base da obra
 * @param {string|null} targetDateStr - Data específica no formato "DD.MM.AAAA". Se null, usa hoje.
 */
function resolveDayFolder(basePath, targetDateStr = null) {
  const dateStr = targetDateStr || getTodayString();  // "05.08.2026"
  let entries = [];

  // 1. Tenta encontrar pasta existente que termine com a data especificada
  if (fs.existsSync(basePath)) {
    entries = fs.readdirSync(basePath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.endsWith(dateStr)) {
        console.log(`      📁 Pasta existente encontrada: ${entry.name}`);
        return path.join(basePath, entry.name);
      }
    }
  }

  // 2. Não achou pasta com essa data → precisa criar com próximo número sequencial
  let maxNum = 0;
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const num = getDayNumberFromFolder(entry.name);
      if (num > maxNum) {
        maxNum = num;
      }
    }
  }

  const nextNum = String(maxNum + 1).padStart(2, '0');
  const folderName = `${nextNum} - ${dateStr}`;
  const dayPath = path.join(basePath, folderName);
  ensureDir(dayPath);
  console.log(`      📁 Nova pasta criada: ${folderName}`);
  return dayPath;
}

function getFoldersForDay(basePath, targetDateStr = null) {
  const dayPath = resolveDayFolder(basePath, targetDateStr);
  return {
    base: dayPath,
    fotosVideos: path.join(dayPath, 'Fotos e Vídeos'),
    documentos: path.join(dayPath, 'Documentos'),
    audios: path.join(dayPath, 'Áudios'),
    transcript: path.join(dayPath, 'TRANSCRIPT')
  };
}

function createDayStructure(basePath, targetDateStr = null) {
  const f = getFoldersForDay(basePath, targetDateStr);
  ensureDir(f.fotosVideos);
  ensureDir(f.documentos);
  ensureDir(f.audios);
  ensureDir(f.transcript);
  return f;
}

module.exports = {
  getTodayString,
  getDateString,
  getTodayDayNumber,
  getNowTimeString,
  formatTimestamp,
  isToday,
  isDate,
  ensureDir,
  resolveDayFolder,
  getFoldersForDay,
  createDayStructure
};
