import {createRuntime} from './index.js';
import {createCheckedReader} from './checked-reader.js';
import {createDrivenResourceAuthority,type ResourceAuthorityOptions,type ResourceAuthority} from './resource-authority-driver.js';
export type * from './resource-authority-driver.js';
/** Web defaults. Native hosts use createNativeResourceAuthority from native-reader. */
export function createResourceAuthority<T=unknown>(options:ResourceAuthorityOptions<T>):ResourceAuthority<T>{
 if((options.runtime===undefined)!==(options.reader===undefined))throw Error('authz_authority_config_invalid');
 return createDrivenResourceAuthority({...options,runtime:options.runtime??createRuntime,reader:options.reader??createCheckedReader});
}
