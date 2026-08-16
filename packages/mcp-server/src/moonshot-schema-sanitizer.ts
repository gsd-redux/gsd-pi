const UNSUPPORTED_SCHEMA_KEYS = new Set([
	"$schema",
	"$id",
	"$anchor",
	"$dynamicAnchor",
	"$vocabulary",
	"$comment",
	"$defs",
	"definitions",
	"unevaluatedProperties",
	"$ref",
	"nullable",
	"examples",
	"example",
	"readOnly",
	"writeOnly",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inferJsonSchemaType(value: unknown): string {
	if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
	if (typeof value === "boolean") return "boolean";
	return "string";
}

function mergePropertySchemas(leftValue: unknown, rightValue: unknown): unknown {
	if (!isRecord(leftValue) || !isRecord(rightValue)) return rightValue;

	if (leftValue.const !== undefined && rightValue.const !== undefined) {
		const values = Array.from(new Set([leftValue.const, rightValue.const]));
		const { const: _leftConst, ...left } = leftValue;
		const { const: _rightConst, ...right } = rightValue;
		return {
			...left,
			...right,
			type: values.every((value) => typeof value === "string") ? "string" : right.type ?? left.type,
			enum: values,
		};
	}

	if (Array.isArray(leftValue.enum) || Array.isArray(rightValue.enum)) {
		return {
			...leftValue,
			...rightValue,
			enum: Array.from(
				new Set([
					...(Array.isArray(leftValue.enum) ? leftValue.enum : []),
					...(Array.isArray(rightValue.enum) ? rightValue.enum : []),
				]),
			),
		};
	}

	return { ...leftValue, ...rightValue };
}

function mergeObjectVariants(variants: Record<string, unknown>[]): Record<string, unknown> {
	const properties = variants.reduce<Record<string, unknown>>((merged, variant) => {
		if (!isRecord(variant.properties)) return merged;
		for (const [name, schema] of Object.entries(variant.properties)) {
			merged[name] = mergePropertySchemas(merged[name], schema);
		}
		return merged;
	}, {});

	return {
		type: "object",
		properties,
	};
}

function selectUnionVariant(variants: unknown[]): Record<string, unknown> {
	const records = variants.filter(isRecord);
	const enumVariants = records.filter((variant) => Array.isArray(variant.enum) && variant.enum.length === 1);
	if (records.length > 0 && enumVariants.length === records.length) {
		const values = enumVariants.map((variant) => (variant.enum as unknown[])[0]);
		const types = new Set(values.map(inferJsonSchemaType));
		return {
			type: types.size === 1 ? [...types][0] : "string",
			enum: values,
		};
	}

	const objectVariants = records.filter((variant) => variant.type === "object");
	if (objectVariants.length > 0 && objectVariants.length === records.length) {
		return mergeObjectVariants(objectVariants);
	}

	const arrayVariant = records.find((variant) => variant.type === "array");
	const stringVariant = records.find((variant) => variant.type === "string");
	if (arrayVariant && stringVariant && records.length === 2) return arrayVariant;
	if (objectVariants[0] && stringVariant && records.length === 2) return objectVariants[0];
	return records[0] ?? { type: "string" };
}

function sanitizeSchemaNode(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sanitizeSchemaNode);
	if (!isRecord(value)) return value;

	let schema = value;
	if (isRecord(schema.patternProperties)) {
		const { patternProperties, ...withoutPatterns } = schema;
		if (!("additionalProperties" in withoutPatterns)) {
			const patterns = Object.values(patternProperties).map(sanitizeSchemaNode);
			schema = {
				...withoutPatterns,
				...(patterns.length === 1 ? { additionalProperties: patterns[0] } : {}),
				...(patterns.length > 1 ? { additionalProperties: true } : {}),
			};
		} else {
			schema = withoutPatterns;
		}
	}

	const unionKey = ["oneOf", "anyOf", "allOf"].find((key) => Array.isArray(schema[key]));
	if (unionKey) {
		const variants = (schema[unionKey] as unknown[]).map(sanitizeSchemaNode);
		const { [unionKey]: _union, type: _type, ...rest } = schema;
		return sanitizeSchemaNode({ ...selectUnionVariant(variants), ...rest });
	}

	if ("const" in schema) {
		const { const: constValue, ...rest } = schema;
		return sanitizeSchemaNode({
			...rest,
			type: rest.type ?? inferJsonSchemaType(constValue),
			enum: rest.enum ?? [constValue],
		});
	}

	const sanitized: Record<string, unknown> = {};
	for (const [key, nested] of Object.entries(schema)) {
		if (UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
		if (key === "additionalProperties" && nested === false) continue;
		if (key === "required" && Array.isArray(nested) && nested.length === 0) continue;
		if (key === "additionalProperties" && isRecord(nested) && Object.keys(nested).length === 0) {
			sanitized[key] = true;
			continue;
		}
		sanitized[key] = sanitizeSchemaNode(nested);
	}
	return sanitized;
}

export function sanitizeSchemaForMoonshot(schema: unknown): Record<string, unknown> {
	const normalized = isRecord(schema) ? sanitizeSchemaNode(schema) : {};
	const sanitized = isRecord(normalized) ? normalized : {};
	const properties = isRecord(sanitized.properties) ? sanitized.properties : {};
	return {
		type: "object",
		properties,
		...(Array.isArray(sanitized.required) && sanitized.required.length > 0
			? { required: sanitized.required.filter((name): name is string => typeof name === "string") }
			: {}),
	};
}
