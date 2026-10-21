/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { boxTriangles, CUBE_MIN, CUBE_SIZE, indexed, meshObjectXml, modelXml, threeMf, zip } from '../../test/fixtures/tiny-generator';
import { inspectMesh } from '../geom/stats';
import { handleParseRequest, parseMesh, parseStl, type ParseResponse } from './parse';
import { StlError } from './sniff';
import { isZip, MAX_3MF_TRIANGLES, parse3mf, parseModelXml, THREEMF_UNITS } from './threemf';

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url)));
const cubeObject = (id = 1, type = 'model'): string => meshObjectXml(id, indexed(boxTriangles(CUBE_MIN, CUBE_SIZE)), type);
const unitCube = (id: number): string => meshObjectXml(id, indexed(boxTriangles([0, 0, 0], [1, 1, 1])));

/** Parses a model part on its own, wrapped in a package. */
const parseModel = (model: string, deflate = false) => parse3mf(threeMf(model, { deflate }));
const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof StlError)) throw e;
    return e.message;
  }
  throw new Error('expected a StlError');
};

describe('parse3mf: the cube fixture', () => {
  it('cube-20mm.3mf reports millimetres and the very same stats as the 20 mm cube STL', () => {
    const m = parse3mf(fixture('cube-20mm.3mf'));
    expect(m.unit).toBe('millimeter');
    expect(m.mmPerUnit).toBe(1);
    expect(m.triangles).toBe(12);
    const stl = parseStl(fixture('cube-20mm-binary.stl'));
    // The same triangles in the same order and winding: the soup is bit-identical, so every stat is.
    expect(Array.from(m.positions)).toEqual(Array.from(stl.positions));
    const a = inspectMesh(m.positions).stats;
    const b = inspectMesh(stl.positions).stats;
    expect(a).toEqual(b);
    expect(a.size).toEqual([20, 20, 20]);
    expect(a.volumeMm3).toBeCloseTo(8000, 6);
    expect(a.areaMm2).toBeCloseTo(2400, 6);
    expect(a.vertices).toBe(8);
    expect(a.watertight).toBe(true);
  });

  it('cube-1in.3mf states inches: ×25.4 to mm, read from the file', () => {
    const m = parse3mf(fixture('cube-1in.3mf'));
    expect(m.unit).toBe('inch');
    expect(m.mmPerUnit).toBe(25.4);
    expect(inspectMesh(m.positions).stats.size).toEqual([1, 1, 1]); // file units; the viewer scales by mmPerUnit
  });

  it('parseMesh tells a 3MF from an STL by its bytes, and the worker posts the unit', () => {
    expect(isZip(fixture('cube-20mm.3mf'))).toBe(true);
    expect(isZip(fixture('cube-20mm-binary.stl'))).toBe(false);
    expect(parseMesh(fixture('cube-20mm.3mf'))).toMatchObject({ format: '3mf', triangles: 12, units: { unit: 'millimeter', mmPerUnit: 1 } });
    expect(parseMesh(fixture('cube-20mm-binary.stl'))).toMatchObject({ format: 'stl-bin', units: null });
    const posted: ParseResponse[] = [];
    handleParseRequest({ id: 4, buffer: fixture('cube-1in.3mf').slice().buffer }, (m) => posted.push(m));
    const done = posted.at(-1)!;
    if (done.type !== 'done') throw new Error(`expected done, got ${done.type}`);
    expect(done.format).toBe('3mf');
    expect(done.units).toEqual({ unit: 'inch', mmPerUnit: 25.4 });
    expect(done.inspection!.stats.watertight).toBe(true);
  });
});

describe('parse3mf: units, transforms, components', () => {
  it('reads every unit the spec names, millimetres when the attribute is absent, and refuses any other', () => {
    for (const [unit, mm] of Object.entries(THREEMF_UNITS)) {
      expect(parseModel(modelXml(unit, [unitCube(1)], ['<item objectid="1" />']))).toMatchObject({ unit, mmPerUnit: mm });
    }
    expect(parseModel(modelXml(null, [unitCube(1)], ['<item objectid="1" />'])).unit).toBe('millimeter');
    expect(refusal(() => parseModel(modelXml('furlong', [unitCube(1)], ['<item objectid="1" />'])))).toMatch(/unit .*"furlong"/);
  });

  it('reads a deflated package the same as a stored one', () => {
    const model = modelXml('millimeter', [cubeObject()], ['<item objectid="1" />']);
    expect(Array.from(parseModel(model, true).positions)).toEqual(Array.from(parseModel(model).positions));
  });

  it('applies a build item transform (row vector · M: the last row is the translation)', () => {
    // A quarter turn about Z (x → y, y → −x), then +100 in X.
    const m = parseModel(modelXml('millimeter', [unitCube(1)], ['<item objectid="1" transform="0 1 0 -1 0 0 0 0 1 100 0 0" />']));
    const s = inspectMesh(m.positions).stats;
    expect(s.bbox).toEqual({ min: [99, 0, 0], max: [100, 1, 1] });
    expect(s.watertight).toBe(true);
    expect(s.flippedHint).toBe(false);
  });

  it('expands components under their transforms, then the item transform, and builds every item', () => {
    const parent = `   <object id="9" type="model"><components>
      <component objectid="1" />
      <component objectid="1" transform="1 0 0 0 1 0 0 0 1 5 0 0" />
    </components></object>`;
    const m = parseModel(modelXml('millimeter', [unitCube(1), parent], ['<item objectid="9" transform="2 0 0 0 2 0 0 0 2 0 0 10" />', '<item objectid="1" />']));
    expect(m.triangles).toBe(36);
    // Item 1: two cubes, the second 5 along X, then ×2 and +10 in Z: X 0..2 and 10..12, Z 10..12; item 2: the unit cube.
    expect(inspectMesh(m.positions).stats.bbox).toEqual({ min: [0, 0, 0], max: [12, 2, 12] });
  });

  it('skips support and other objects, refuses when nothing is left to build', () => {
    const m = parseModel(modelXml('millimeter', [unitCube(1), meshObjectXml(2, indexed(boxTriangles([5, 5, 5], [1, 1, 1])), 'support')], ['<item objectid="1" />', '<item objectid="2" />']));
    expect(m.triangles).toBe(12);
    expect(refusal(() => parseModel(modelXml('millimeter', [meshObjectXml(2, indexed(boxTriangles([0, 0, 0], [1, 1, 1])), 'support')], ['<item objectid="2" />'])))).toMatch(/no triangles to build/);
  });

  it('accepts namespace-prefixed elements', () => {
    const xml = modelXml('millimeter', [unitCube(1)], ['<item objectid="1" />']).replace(/<(\/?)(model|resources|object|mesh|vertices|vertex|triangles|triangle|build|item)\b/g, '<$1m:$2');
    expect(parseModelXml(xml).triangles).toBe(12);
  });
});

describe('parse3mf: refusals, each one named', () => {
  const item = ['<item objectid="1" />'];
  it.each([
    ['no build items', modelXml('millimeter', [unitCube(1)], []), /builds nothing/],
    ['an item naming no object', modelXml('millimeter', [unitCube(1)], ['<item />']), /names no object/],
    ['an item naming a missing object', modelXml('millimeter', [unitCube(1)], ['<item objectid="7" />']), /object 7, which it does not define/],
    ['a triangle index past the vertices', modelXml('millimeter', [unitCube(1).replace('v1="0"', 'v1="8"')], item), /uses vertex 8, but the object has 8/],
    ['a negative triangle index', modelXml('millimeter', [unitCube(1).replace('v1="0"', 'v1="-1"')], item), /uses vertex -1/],
    ['a missing triangle index', modelXml('millimeter', [unitCube(1).replace('v1="0" ', '')], item), /uses vertex \(missing\)/],
    ['a vertex that is not a number', modelXml('millimeter', [unitCube(1).replace('x="0"', 'x="abc"')], item), /not a number/],
    ['a bad transform', modelXml('millimeter', [unitCube(1)], ['<item objectid="1" transform="1 0 0" />']), /not 12 numbers/],
    ['a transform past float32', modelXml('millimeter', [unitCube(1)], ['<item objectid="1" transform="1e39 0 0 0 1 0 0 0 1 0 0 0" />']), /too large to store/],
    ['a component loop', modelXml('millimeter', ['<object id="1"><components><component objectid="2" /></components></object>', '<object id="2"><components><component objectid="1" /></components></object>'], item), /nest more than 32 deep/],
    ['an object in another model part', modelXml('millimeter', ['<object id="1"><components><component p:path="/3D/other.model" objectid="2" /></components></object>'], item), /production extension/],
    ['no model element', '<?xml version="1.0"?><notamodel />', /no <model> element/],
  ])('%s', (_what, model, why) => {
    expect(refusal(() => parseModel(model))).toMatch(why);
  });

  it('a ZIP with no model part is not a 3MF; a broken ZIP is named as such', () => {
    const plain = zip([{ name: 'readme.txt', data: new TextEncoder().encode('hello') }]);
    expect(refusal(() => parse3mf(plain))).toMatch(/holds no 3D model .*not a 3MF/);
    const broken = fixture('cube-20mm.3mf').slice(0, 200);
    expect(refusal(() => parse3mf(broken))).toMatch(/could not be unpacked|holds no 3D model/);
  });

  it('a component tree that multiplies past the size limit is refused before anything is allocated', () => {
    // Each level uses the one below twice: 2^24 cubes of 12 triangles, far past the limit, counted (memoised) not built.
    const levels = Array.from({ length: 24 }, (_, i) => `<object id="${i + 2}"><components><component objectid="${i + 1}" /><component objectid="${i + 1}" /></components></object>`);
    const message = refusal(() => parseModel(modelXml('millimeter', [unitCube(1), ...levels], ['<item objectid="25" />'])));
    expect(message).toMatch(/builds 201,326,592 triangles; more than/);
    expect(MAX_3MF_TRIANGLES).toBe(Math.floor((500 * 1024 * 1024) / 50));
  });

  it('the model part named by _rels/.rels is the one read', () => {
    const model = modelXml('centimeter', [unitCube(1)], ['<item objectid="1" />']);
    expect(parse3mf(threeMf(model, { modelPath: '3D/part.model' })).unit).toBe('centimeter');
  });
});
