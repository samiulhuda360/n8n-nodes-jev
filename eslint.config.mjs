// Lints the node and credential with the rules n8n applies to its own nodes.
import tsParser from '@typescript-eslint/parser';
import n8nNodesBase from 'eslint-plugin-n8n-nodes-base';

const { configs } = n8nNodesBase;

export default [
  { ignores: ['dist/**', 'node_modules/**', '.n8n-test/**', 'eval/**', 'scripts/**', 'test/**'] },
  {
    files: ['nodes/**/*.ts'],
    languageOptions: { parser: tsParser, sourceType: 'module' },
    plugins: { 'n8n-nodes-base': n8nNodesBase },
    rules: {
      ...configs.nodes.rules,
      // These two rules predate NodeConnectionTypes, which current n8n versions use for inputs and outputs.
      'n8n-nodes-base/node-class-description-inputs-wrong-regular-node': 'off',
      'n8n-nodes-base/node-class-description-outputs-wrong': 'off',
    },
  },
  {
    files: ['credentials/**/*.ts'],
    languageOptions: { parser: tsParser, sourceType: 'module' },
    plugins: { 'n8n-nodes-base': n8nNodesBase },
    rules: { ...configs.credentials.rules },
  },
];
