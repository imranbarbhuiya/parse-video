import common from 'eslint-config-mahir/common';
import module from 'eslint-config-mahir/module';
import node from 'eslint-config-mahir/node';
import react from 'eslint-config-mahir/react';
import typescript from 'eslint-config-mahir/typescript';

/**
 * @type {import('@typescript-eslint/utils').TSESLint.FlatConfig.ConfigArray}
 */
export default [
	...common,
	...node,
	...typescript,
	...module,
	...react,
	{
		ignores: ['.github', '.yarn', 'node_modules', 'dist', 'build'],
	},
];
