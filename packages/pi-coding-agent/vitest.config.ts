import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const aiSrcIndex = fileURLToPath(new URL("../pi-ai/src/index.ts", import.meta.url));
const aiSrcOAuth = fileURLToPath(new URL("../pi-ai/src/oauth.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("../pi-agent-core/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		server: {
			deps: {
				external: [/@silvia-odwyer\/photon-node/],
			},
		},
	},
	resolve: {
		alias: [
			{ find: /^@earendil-works\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@earendil-works\/pi-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@earendil-works\/pi-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@mariozechner\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@mariozechner\/pi-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@mariozechner\/pi-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@gsd\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@gsd\/pi-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@gsd\/pi-agent-core$/, replacement: agentSrcIndex },
		],
	},
});
