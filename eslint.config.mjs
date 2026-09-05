import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{
		ignores: ["out/**", "node_modules/**", "scripts/**"],
	},
	eslint.configs.recommended,
	...tseslint.configs.recommended,
	{
		rules: {
			"@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
			"@typescript-eslint/no-explicit-any": "off",
		},
	}
);
