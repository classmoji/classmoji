import reactConfig from './react.js';
import typescriptConfig from './typescript.js';

export default [
  ...reactConfig,
  ...typescriptConfig,
  {
    settings: {
      'import/resolver': {
        alias: {
          map: [['~', './app']],
          extensions: ['.js', '.jsx', '.ts', '.tsx', '.json'],
        },
        node: {
          extensions: ['.js', '.jsx', '.ts', '.tsx'],
        },
        typescript: {
          project: './tsconfig.json',
        },
      },
    },
  },
];
