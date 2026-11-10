/**
 * The parts of Figma's REST file format that usabl reads, and the check that a network answer has
 * that shape before anything reads it.
 *
 * The types are kept local so usabl's published types never depend on Figma's package. They are
 * written by hand to match a subset of Figma's published file format (GetFileResponse). Nothing in
 * this repository checks them against Figma's own package yet.
 * Dev Mode annotations are typed as a bare object in Figma's REST types, so their shape follows the
 * Plugin API (label, labelMarkdown) and is to be confirmed on a real design file.
 *
 * Every string in a Figma file is untrusted data: layer names, text, property values, and notes
 * are written by whoever can edit the design. readFigmaFile keeps only the fields below, and the
 * importer neutralizes each string before it reaches a requirement or a message.
 */
import { z } from 'zod';

export interface FigmaRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
// The value of a slot property: an id for the slot's content, never text.
export interface FigmaSlotContentId {
  guid: { sessionID: number; localID: number };
}
export interface FigmaComponentProperty {
  type: string;
  value: boolean | string | FigmaSlotContentId;
}
export interface FigmaAnnotation {
  label?: string;
  labelMarkdown?: string;
}
export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  children?: FigmaNode[];
  characters?: string;
  absoluteBoundingBox?: FigmaRect | null;
  componentId?: string;
  componentProperties?: Record<string, FigmaComponentProperty>;
  annotations?: FigmaAnnotation[];
}
export interface FigmaComponentMeta {
  key?: string;
  name: string;
  componentSetId?: string;
}
export interface FigmaFile {
  name: string;
  version: string;
  lastModified: string;
  document: FigmaNode;
  components: Record<string, FigmaComponentMeta>;
  componentSets?: Record<string, { name: string }>;
}

const rectSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite(),
  height: z.number().finite(),
});

const annotationSchema = z.object({
  label: z.string().optional(),
  labelMarkdown: z.string().optional(),
});

// Figma's published types allow a slot id as a value, so a file whose components use slots is
// still a file usabl can read. Only the id fields are kept.
const slotContentIdSchema = z
  .object({ guid: z.object({ sessionID: z.number(), localID: z.number() }) })
  .transform(({ guid }) => ({ guid: { sessionID: guid.sessionID, localID: guid.localID } }));

const propertySchema = z.object({
  type: z.string(),
  value: z.union([z.boolean(), z.string(), slotContentIdSchema]),
});

// Unknown fields are dropped, so nothing usabl does not read is ever carried along.
const nodeSchema: z.ZodType<FigmaNode, z.ZodTypeDef, unknown> = z.lazy(() =>
  z
    .object({
      id: z.string(),
      name: z.string(),
      type: z.string(),
      children: z.array(nodeSchema).optional(),
      characters: z.string().optional(),
      absoluteBoundingBox: rectSchema.nullable().optional(),
      componentId: z.string().optional(),
      componentProperties: z.record(propertySchema).optional(),
      // Other annotation fields, such as measurements, are not read.
      annotations: z.array(annotationSchema).optional(),
    })
    .transform((node) => {
      const out: FigmaNode = { id: node.id, name: node.name, type: node.type };
      if (node.children !== undefined) out.children = node.children;
      if (node.characters !== undefined) out.characters = node.characters;
      if (node.absoluteBoundingBox !== undefined) out.absoluteBoundingBox = node.absoluteBoundingBox;
      if (node.componentId !== undefined) out.componentId = node.componentId;
      if (node.componentProperties !== undefined) out.componentProperties = node.componentProperties;
      if (node.annotations !== undefined) {
        out.annotations = node.annotations.map((note) => ({
          ...(note.label === undefined ? {} : { label: note.label }),
          ...(note.labelMarkdown === undefined ? {} : { labelMarkdown: note.labelMarkdown }),
        }));
      }
      return out;
    }),
);

const fileSchema = z.object({
  name: z.string(),
  version: z.string(),
  lastModified: z.string(),
  document: nodeSchema,
  components: z.record(
    z.object({ key: z.string().optional(), name: z.string(), componentSetId: z.string().optional() }),
  ),
  componentSets: z.record(z.object({ name: z.string() })).optional(),
});

/**
 * The file a network answer holds, with only the fields usabl reads, or null when the answer is
 * not a Figma file usabl can read. A file nested too deeply to check is not one either.
 */
export function readFigmaFile(value: unknown): FigmaFile | null {
  let parsed: z.SafeParseReturnType<unknown, z.infer<typeof fileSchema>>;
  try {
    parsed = fileSchema.safeParse(value);
  } catch {
    return null;
  }
  if (!parsed.success) {
    return null;
  }
  const { name, version, lastModified, document, components, componentSets } = parsed.data;
  const file: FigmaFile = {
    name,
    version,
    lastModified,
    document,
    components: Object.fromEntries(
      Object.entries(components).map(([id, meta]) => [
        id,
        {
          name: meta.name,
          ...(meta.key === undefined ? {} : { key: meta.key }),
          ...(meta.componentSetId === undefined ? {} : { componentSetId: meta.componentSetId }),
        },
      ]),
    ),
  };
  if (componentSets !== undefined) {
    file.componentSets = componentSets;
  }
  return file;
}
