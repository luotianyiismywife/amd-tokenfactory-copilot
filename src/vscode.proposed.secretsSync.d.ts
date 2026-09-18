/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// https://github.com/microsoft/vscode/issues/152924 @jrieken

declare module "vscode" {
	export interface SecretStorage {
		/**
		 * Registers a callback that is called whenever a secret should be synced or not.
		 */
		setKeysForSync(keys: string[]): Thenable<void>;
	}
}
