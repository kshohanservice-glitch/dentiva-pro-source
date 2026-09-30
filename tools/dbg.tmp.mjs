import { readFileSync } from 'node:fs';
import ts from 'typescript';
const text = readFileSync('src/core/seed.ts', 'utf8');
const source = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const out = [];
const walk = (node, depth) => {
  if (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateExpression(node) ||
    (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
  ) {
    out.push(ts.SyntaxKind[node.kind] + ' :: ' + node.getText(source).slice(0, 90).replace(/\n/g, '\\n'));
  }
  ts.forEachChild(node, (child) => walk(child, depth + 1));
};
walk(source, 0);
console.log(out.slice(15, 24).join('\n---\n'));
