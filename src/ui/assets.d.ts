// esbuild resolves CSS imports into the bundle; TypeScript needs to be told they exist.
declare module '*.css' {
  const content: string
  export default content
}
