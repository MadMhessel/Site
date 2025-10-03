module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/tests'],
  moduleNameMapper: {
    '^(.*)\\.(css)$': '<rootDir>/tests/styleMock.ts',
    '^@/(.*)$': '<rootDir>/src/$1',
    '^\.\./src/(.*)\\.js$': '<rootDir>/src/$1.ts'
  },
  transform: {
    '^.+\\.(ts|tsx)$': ['ts-jest', { tsconfig: './tsconfig.test.json' }]
  }
};
