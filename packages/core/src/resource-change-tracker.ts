import {createRuntime} from './index.js';
import {createDrivenResourceChangeTracker,type ResourceChangeTrackerOptions} from './resource-change-tracker-driver.js';
export type * from './resource-change-tracker-driver.js';
export function createResourceChangeTracker(options:ResourceChangeTrackerOptions){
 return createDrivenResourceChangeTracker(options,options.runtime??createRuntime);
}
