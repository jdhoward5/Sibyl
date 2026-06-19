// electron-squirrel-startup ships no types. Its default export is a boolean:
// true when a Squirrel install/update/uninstall event was handled (and the app
// should quit immediately).
declare module 'electron-squirrel-startup' {
  const startup: boolean
  export default startup
}
