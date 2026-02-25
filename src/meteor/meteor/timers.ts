import { bindEnvironment, type Func } from './dynamics';

export function defer<TFunc extends Func>(func: TFunc): void {
  setTimeout(bindEnvironment(func), 0);
}

export function setTimeoutWrapped<TFunc extends Func>(func: TFunc, delay: number) {
  return setTimeout(bindEnvironment(func), delay);
}

export function setIntervalWrapped<TFunc extends Func>(func: TFunc, delay: number) {
  return setInterval(bindEnvironment(func), delay);
}

export function clearTimeoutWrapped(id: ReturnType<typeof setTimeout>) {
  clearTimeout(id);
}

export function clearIntervalWrapped(id: ReturnType<typeof setInterval>) {
  clearInterval(id);
}