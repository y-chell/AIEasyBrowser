process.stderr.write(`native-host-fixture:${JSON.stringify(process.argv.slice(2))}\n`);
process.stdin.pipe(process.stdout);
process.stdin.on('end', () => {
  process.exitCode = Number(process.env.AIEASYBROWSER_FIXTURE_EXIT_CODE || '0');
});
