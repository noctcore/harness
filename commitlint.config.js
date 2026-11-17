export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-empty': [2, 'never'],
    'scope-enum': [
      2,
      'always',
      ['harness', 'harness-mutation', 'repo', 'deps', 'ci', 'docs', 'release'],
    ],
    'body-max-line-length': [2, 'always', 100],
  },
};
