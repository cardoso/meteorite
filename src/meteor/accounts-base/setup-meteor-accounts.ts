import { Meteor } from 'meteor/meteor';
import { Accounts } from 'meteor/accounts-base'; // Export your instantiated AccountsClient here

export function setupMeteorAccounts() {
  // Bind core reactive data sources
  (Meteor as any).user = (options?: any) => Accounts.user(options);
  (Meteor as any).userAsync = (options?: any) => Accounts.userAsync(options);
  (Meteor as any).userId = () => Accounts.userId();
  
  // Bind logging state
  (Meteor as any).loggingIn = () => Accounts.loggingIn();
  (Meteor as any).loggingOut = () => Accounts.loggingOut();

  // Bind actions
  (Meteor as any).logout = (callback?: Function) => Accounts.logout(callback);
  (Meteor as any).logoutAllClients = (callback?: Function) => Accounts.logoutAllClients(callback);
  (Meteor as any).logoutOtherClients = (callback?: Function) => Accounts.logoutOtherClients(callback);
  
  // Example for specific login methods you might port later
  (Meteor as any).loginWithPassword = (...args: any[]) => (Accounts as any).loginWithPassword(...args);
}