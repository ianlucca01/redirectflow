#!/usr/bin/env node
// Refator do workflow GLOBAL — Fase 1: remoção de código morto.
//
// O QUE FAZ
//   Remove nós com `disabled: true` que estão no JSON do workflow mas nunca
//   executam. Limpa também as conexões órfãs apontando para esses nós.
//   Nenhuma mudança de comportamento — nós desativados já não rodavam.
//
// SEGURANÇA
//   - Recusa remover qualquer nó que não esteja marcado como `disabled: true`.
//   - Falha se o arquivo de saída já existir (use --force pra sobrescrever).
//   - Idempotente: rodar duas vezes não causa estrago.
//
// USO
//   node workflows/refactor-global.mjs <input.json> <output.json> [--force]
//
// FLUXO RECOMENDADO
//   1. Export do workflow GLOBAL no n8n (Download)
//   2. Salve como workflows/global.original.json (NÃO commitar — segredos)
//   3. Rode: node workflows/refactor-global.mjs \
//            workflows/global.original.json \
//            workflows/global.fase1.json
//   4. Importe `global.fase1.json` num workflow DE TESTE no n8n
//   5. Compare canvas com o original — devem ter os mesmos nós executáveis
//   6. Se OK, ative em produção (com backup do original guardado)

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const force = args.includes('--force');
const [inputPath, outputPath] = args.filter(a => !a.startsWith('--'));

if (!inputPath || !outputPath) {
  console.error('Uso: node refactor-global.mjs <input.json> <output.json> [--force]');
  process.exit(1);
}

if (!fs.existsSync(inputPath)) {
  console.error(`❌ Arquivo de entrada não existe: ${inputPath}`);
  process.exit(1);
}

if (fs.existsSync(outputPath) && !force) {
  console.error(`❌ Arquivo de saída já existe: ${outputPath}`);
  console.error('   Use --force para sobrescrever, ou escolha outro nome.');
  process.exit(1);
}

const wf = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

if (!Array.isArray(wf.nodes) || typeof wf.connections !== 'object') {
  console.error('❌ JSON não parece ser um workflow n8n válido (sem `nodes` ou `connections`)');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Lista de nós a remover. Todos DEVEM ter `disabled: true` no workflow atual.
// O script aborta a remoção de qualquer nó que esteja ativo, por segurança.
// ─────────────────────────────────────────────────────────────────────────────
const NODES_TO_REMOVE = [
  // Branch de OG image desabilitada (substituída por puppeter :3050)
  'pega imagem',

  // Desencurtador RapidAPI antigo (substituído por desencurtador local :3052)
  'API DESENCURTAR LINK',

  // Tentativa de log antifraude (Get a row → If → Create) — toda desabilitada
  'Get a row10',
  'If12',
  'Create a row',
  'Get a row11',
  'If13',
  'Create a row1',
];

const removed = [];
const skipped = [];

for (const name of NODES_TO_REMOVE) {
  const node = wf.nodes.find(n => n.name === name);
  if (!node) {
    skipped.push({ name, reason: 'não encontrado no workflow' });
    continue;
  }
  if (node.disabled !== true) {
    skipped.push({ name, reason: 'NÃO está desabilitado — recusando remover' });
    continue;
  }
  removed.push(name);
}

const removedSet = new Set(removed);

// Remove os nós da lista de nodes
const beforeCount = wf.nodes.length;
wf.nodes = wf.nodes.filter(n => !removedSet.has(n.name));
const nodesRemovedCount = beforeCount - wf.nodes.length;

// Remove as conexões que SAEM dos nós removidos
for (const name of removed) {
  if (wf.connections[name]) delete wf.connections[name];
}

// Remove as conexões que ENTRAM nos nós removidos
let danglingCleaned = 0;
for (const [src, conn] of Object.entries(wf.connections)) {
  if (!conn || typeof conn !== 'object') continue;
  for (const type of Object.keys(conn)) {
    if (!Array.isArray(conn[type])) continue;
    conn[type] = conn[type].map(arr => {
      if (!Array.isArray(arr)) return arr;
      return arr.filter(c => {
        if (c && removedSet.has(c.node)) { danglingCleaned++; return false; }
        return true;
      });
    });
  }
}

fs.writeFileSync(outputPath, JSON.stringify(wf, null, 2) + '\n');

// ─────────────────────────────────────────────────────────────────────────────
// Relatório
// ─────────────────────────────────────────────────────────────────────────────
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  Fase 1 — Remoção de código morto');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log();
console.log(`Entrada:  ${path.resolve(inputPath)}`);
console.log(`Saída:    ${path.resolve(outputPath)}`);
console.log();
console.log(`Nós antes:      ${beforeCount}`);
console.log(`Nós depois:     ${wf.nodes.length}`);
console.log(`Nós removidos:  ${nodesRemovedCount}`);
console.log(`Conexões órfãs limpas: ${danglingCleaned}`);
console.log();

if (removed.length) {
  console.log('✅ Removidos:');
  removed.forEach(n => console.log(`   • ${n}`));
}
if (skipped.length) {
  console.log();
  console.log('⚠️  Pulados:');
  skipped.forEach(s => console.log(`   • ${s.name} — ${s.reason}`));
}
console.log();
console.log('Próximo passo: importar a saída num workflow DE TESTE no n8n');
console.log('e comparar com o original antes de promover pra produção.');
