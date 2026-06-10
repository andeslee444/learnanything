async function shout(name: string) {
  'use step';
  return `HELLO, ${name.toUpperCase()}`;
}

export async function helloWorkflow(name: string) {
  'use workflow';
  return shout(name);
}
