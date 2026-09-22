declare module "occt-import-js" {
  const initialize: (options: { locateFile: (name: string) => string; print: () => void; printErr: () => void }) => Promise<import("./parse").CadImporter>;
  export default initialize;
}
