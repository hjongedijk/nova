import type { ApiOperation, ApiParam } from "./api.types.js";
import { classify } from "./risk.js";
import { newOperation, oneLine, uniqueId } from "./spec-util.js";
import { arr, parseXml } from "./xml.js";

type Node = Record<string, unknown>;
const obj = (value: unknown): Node =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Node)
    : {};
const local = (value: unknown) => String(value ?? "").replace(/^.*:/, "");
const NAME = /^[A-Za-z_][\w.-]*$/;

export function looksLikeWsdl(text: string): boolean {
  return /<(?:\w+:)?definitions[\s>]/.test(text.slice(0, 4000));
}

/** Basic WSDL 1.1: operations, SOAPAction, flat request parameters, endpoint address. SOAP 1.1 document/literal and rpc only. */
export function parseWsdl(text: string): {
  operations: ApiOperation[];
  endpoint?: string;
  title: string;
  notes: string[];
} | null {
  const root = obj(parseXml(text)?.definitions);
  if (!Object.keys(root).length) return null;
  const notes: string[] = [];
  const namespace = String(root["@_targetNamespace"] ?? "");
  const elements = new Map<string, Node>();
  for (const schema of arr(obj(root.types).schema))
    for (const element of arr(obj(schema).element))
      elements.set(String(obj(element)["@_name"]), obj(element));
  const messages = new Map<string, Node>();
  for (const message of arr(root.message))
    messages.set(String(obj(message)["@_name"]), obj(message));
  const actions = new Map<string, string>();
  for (const binding of arr(root.binding))
    for (const op of arr(obj(binding).operation))
      actions.set(
        String(obj(op)["@_name"]),
        String(obj(obj(op).operation)["@_soapAction"] ?? ""),
      );
  const operations: ApiOperation[] = [];
  const taken = new Set<string>();
  for (const portType of arr(root.portType)) {
    for (const op of arr(obj(portType).operation)) {
      const name = String(obj(op)["@_name"] ?? "");
      if (!NAME.test(name)) continue;
      const message = messages.get(local(obj(obj(op).input)["@_message"]));
      const params: ApiParam[] = [];
      let element = name;
      for (const part of arr(obj(message).part)) {
        const ref = local(obj(part)["@_element"]);
        const definition = ref ? elements.get(ref) : undefined;
        if (ref && definition) {
          element = ref;
          const sequence = obj(
            obj(obj(definition).complexType).sequence ??
              obj(obj(definition).complexType).all,
          );
          for (const child of arr(sequence.element)) {
            const childName = String(obj(child)["@_name"] ?? "");
            if (!NAME.test(childName)) continue;
            const type = local(obj(child)["@_type"]);
            params.push({
              name: childName,
              in: "arg",
              required: obj(child)["@_minOccurs"] !== "0",
              schema: {
                type: /int|long|short/i.test(type)
                  ? "integer"
                  : /decimal|double|float/i.test(type)
                    ? "number"
                    : /boolean/i.test(type)
                      ? "boolean"
                      : "string",
              },
            });
          }
        } else if (NAME.test(String(obj(part)["@_name"] ?? ""))) {
          params.push({
            name: String(obj(part)["@_name"]),
            in: "arg",
            required: true,
            schema: { type: "string" },
          });
        }
      }
      operations.push(
        newOperation({
          id: uniqueId(name, taken),
          summary: oneLine(obj(op).documentation ?? `SOAP operation ${name}`),
          method: "POST",
          path: name,
          params,
          risk: classify({ protocol: "soap", method: "POST", name }),
          soap: { action: actions.get(name) ?? "", namespace, element },
        }),
      );
    }
  }
  let endpoint: string | undefined;
  for (const service of arr(root.service))
    for (const port of arr(obj(service).port))
      endpoint ??=
        String(obj(obj(port).address)["@_location"] ?? "") || undefined;
  if (/soap12|schemas\.xmlsoap\.org\/wsdl\/soap12/i.test(text))
    notes.push(
      "WSDL declares SOAP 1.2 bindings; NOVA speaks SOAP 1.1 (most servers accept it).",
    );
  return {
    operations,
    endpoint,
    title: oneLine(obj(root.service)["@_name"] ?? "SOAP service", 60),
    notes,
  };
}
