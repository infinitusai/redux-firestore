import { Dispatch } from 'redux'
import { isArray, invoke, isFunction, every } from 'lodash';
import { wrapInDispatch } from '../utils/actions';
import { actionTypes } from '../constants';
import {
  attachListener,
  detachListener,
  orderedFromSnap,
  dataByIdSnapshot,
  getQueryConfig,
  getQueryName,
  firestoreRef,
  dispatchListenerResponse,
  getPopulateActions,
} from '../utils/query';
import { to } from '../utils/async';
import { QueryConfigObject, ReduxFirestoreConfig, QueryConfig } from '../types';

const pathListenerCounts: any = {};

/**
 * Add data to a collection or document on Cloud Firestore with the call to
 * the Firebase library being wrapped in action dispatches.
 * @param firebase - Internal firebase object
 * @param dispatch - Redux's dispatch function
 * @param queryOption - Options for query
 * @param doc - Document name
 * @returns Resolves with results of add call
 */
export function add(firebase: any, dispatch: Dispatch, queryOption: any, ...args: any[]): Promise<any> {
  const meta = getQueryConfig(queryOption);
  return wrapInDispatch(dispatch, {
    ref: firestoreRef(firebase, meta),
    method: 'add',
    meta,
    args,
    types: [
      actionTypes.ADD_REQUEST,
      {
        type: actionTypes.ADD_SUCCESS,
        payload: (snap: any) => ({ id: snap.id, data: args[0] }),
      },
      actionTypes.ADD_FAILURE,
    ],
  });
}

/**
 * Set data to a document on Cloud Firestore with the call to
 * the Firebase library being wrapped in action dispatches.
 * @param firebase - Internal firebase object
 * @param dispatch - Redux's dispatch function
 * @param queryOption - Options for query
 * @param doc - Document name
 * @returns Resolves with results of set call
 */
export function set(firebase: any, dispatch: Dispatch, queryOption: any, ...args: any[]): Promise<any> {
  const meta = getQueryConfig(queryOption);
  return wrapInDispatch(dispatch, {
    ref: firestoreRef(firebase, meta),
    method: 'set',
    meta,
    args,
    types: [
      actionTypes.SET_REQUEST,
      actionTypes.SET_SUCCESS,
      actionTypes.SET_FAILURE,
    ],
  });
}

/**
 * Get a collection or document from Cloud Firestore with the call to
 * the Firebase library being wrapped in action dispatches.
 * @param firebase - Internal firebase object
 * @param dispatch - Redux's dispatch function
 * @param queryOption - Options for query
 * @param doc - Document name
 * @returns Resolves with results of get call
 */
export function get(firebase: any, dispatch: Dispatch, queryOption: any): Promise<any> {
  const meta = getQueryConfig(queryOption);
  // Wrap get call in dispatch calls
  const {
    mergeOrdered,
    mergeOrderedDocUpdates,
    mergeOrderedCollectionUpdates,
  } = (firebase._.config as ReduxFirestoreConfig);
  return wrapInDispatch(dispatch, {
    ref: firestoreRef(firebase, meta),
    method: 'get',
    meta,
    types: [
      actionTypes.GET_REQUEST,
      {
        type: actionTypes.GET_SUCCESS,
        payload: (snap: any) => ({
          data: dataByIdSnapshot(snap),
          ordered: orderedFromSnap(snap),
        }),
        merge: {
          docs: mergeOrdered && mergeOrderedDocUpdates,
          collections: mergeOrdered && mergeOrderedCollectionUpdates,
        },
      },
      actionTypes.GET_FAILURE,
    ],
  });
}

/**
 * Update a document on Cloud Firestore with the call to the Firebase library
 * being wrapped in action dispatches.
 * @param firebase - Internal firebase object
 * @param dispatch - Redux's dispatch function
 * @param queryOption - Options for query
 * @param doc - Document name
 * @returns Resolves with results of update call
 */
export function update(firebase: any, dispatch: Dispatch, queryOption: any, ...args: any[]): Promise<any> {
  const meta = getQueryConfig(queryOption);
  return wrapInDispatch(dispatch, {
    ref: firestoreRef(firebase, meta),
    method: 'update',
    meta,
    args,
    types: [
      actionTypes.UPDATE_REQUEST,
      actionTypes.UPDATE_SUCCESS,
      actionTypes.UPDATE_FAILURE,
    ],
  });
}

/**
 * Delete a reference on Cloud Firestore with the call to the Firebase library
 * being wrapped in action dispatches. If attempting to delete a collection
 * delete promise will be rejected with "Only documents can be deleted" unless
 * onAttemptCollectionDelete is provided. This is due to the fact that
 * Collections can not be deleted from a client, it should instead be handled
 * within a cloud function.
 * @param firebase - Internal firebase object
 * @param dispatch - Redux's dispatch function
 * @param queryOption - Options for query
 * @param doc - Document name
 * @returns Resolves with results of update call
 */
export function deleteRef(firebase: any, dispatch: Dispatch, queryOption: any): Promise<any> {
  const meta = getQueryConfig(queryOption);
  const { config } = firebase._;
  if (
    !meta.doc ||
    (meta.subcollections && !every(meta.subcollections, 'doc'))
  ) {
    if (isFunction(config.onAttemptCollectionDelete)) {
      return config.onAttemptCollectionDelete(queryOption, dispatch, firebase);
    }
    return Promise.reject(new Error('Only documents can be deleted.'));
  }
  return wrapInDispatch(dispatch, {
    ref: firestoreRef(firebase, meta),
    method: 'delete',
    meta,
    types: [
      actionTypes.DELETE_REQUEST,
      {
        type: actionTypes.DELETE_SUCCESS,
        preserve: firebase._.config.preserveOnDelete,
      },
      actionTypes.DELETE_FAILURE,
    ],
  });
}

/**
 * Set listener to Cloud Firestore with the call to the Firebase library
 * being wrapped in action dispatches.. Internall calls Firebase's onSnapshot()
 * method.
 * @param firebase - Internal firebase object
 * @param dispatch - Redux's dispatch function
 * @param queryOpts - Options for query
 * @param queryOpts.collection - Collection name
 * @param queryOpts.doc - Document name
 * @param queryOpts.where - Where settings for query. Array of strings
 * for one where, an Array of Arrays for multiple wheres
 * @param successCb - Callback called on success
 * @param errorCb - Callback called on error
 * @return Unsubscribe
 */
export function setListener(firebase: any, dispatch: Dispatch, queryOpts: QueryConfig, successCb?: any, errorCb?: any): () => void {
  const meta = getQueryConfig(queryOpts);

  // Create listener
  const unsubscribe = firestoreRef(firebase, meta).onSnapshot(
    async docData => {
      // Dispatch directly if no populates
      if (!meta.populates) {
        dispatchListenerResponse({ dispatch, docData, meta, firebase });
        // Invoke success callback if it exists
        if (typeof successCb === 'function') successCb(docData);
        return;
      }

      // Run population and dispatch results
      const [populateErr, populateActions] = await to(
        getPopulateActions({ firebase, docData, meta }),
      );

      // Handle errors in population
      if (populateErr) {
        if (firebase._.config.logListenerError) {
          // Log error handling the case of it not existing
          invoke(console, 'error', `Error populating:`, populateErr);
        }
        if (typeof errorCb === 'function') errorCb(populateErr);
        return;
      }

      if (populateActions) {
        // Dispatch each populate action
        populateActions.forEach((value: any) => {
          dispatch({
            ...value,
            type: actionTypes.LISTENER_RESPONSE,
            timestamp: Date.now(),
          });
        });
      }

      // Dispatch original action
      dispatchListenerResponse({ dispatch, docData, meta, firebase });
    },
    (err: Error) => {
      const {
        mergeOrdered,
        mergeOrderedDocUpdates,
        mergeOrderedCollectionUpdates,
        logListenerError,
        preserveOnListenerError
      } = (firebase._.config as ReduxFirestoreConfig);
      // TODO: Look into whether listener is automatically removed in all cases
      // Log error handling the case of it not existing
      if (logListenerError) invoke(console, 'error', err);
      dispatch({
        type: actionTypes.LISTENER_ERROR,
        meta,
        payload: err,
        merge: {
          docs: mergeOrdered && mergeOrderedDocUpdates,
          collections: mergeOrdered && mergeOrderedCollectionUpdates,
        },
        preserve: preserveOnListenerError,
      });
      // Invoke error callback if it exists
      if (typeof errorCb === 'function') errorCb(err);
    },
  );
  attachListener(firebase, dispatch, meta, unsubscribe);

  return unsubscribe;
}

/**
 * Set an array of listeners only allowing for one of a specific configuration.
 * If config.allowMultipleListeners is true or a function
 * (`(listener, listeners) => {}`) that evaluates to true then multiple
 * listeners with the same config are attached.
 * @param firebase - Internal firebase object
 * @param dispatch - Redux's dispatch function
 * @param listeners - Configs for listeners to be set
 */
export function setListeners(firebase: any, dispatch: Dispatch, listeners: QueryConfigObject[]) {
  if (!isArray(listeners)) {
    throw new Error(
      'Listeners must be an Array of listener configs (Strings/Objects).',
    );
  }

  const { config } = firebase._;

  // Only attach one listener (count of matching listener path calls is tracked)
  if (config.oneListenerPerPath) {
    listeners.forEach(listener => {
      const path = getQueryName(listener);
      const oldListenerCount = pathListenerCounts[path] || 0;
      pathListenerCounts[path] = oldListenerCount + 1;

      // If we already have an attached listener exit here
      if (oldListenerCount > 0) {
        return;
      }

      setListener(firebase, dispatch, listener);
    });
  } else {
    const { allowMultipleListeners } = config;

    listeners.forEach(listener => {
      const path = getQueryName(listener);
      const oldListenerCount = pathListenerCounts[path] || 0;
      const multipleListenersEnabled = isFunction(allowMultipleListeners)
        ? allowMultipleListeners(listener, firebase._.listeners)
        : allowMultipleListeners;

      pathListenerCounts[path] = oldListenerCount + 1;

      // If we already have an attached listener exit here
      if (oldListenerCount === 0 || multipleListenersEnabled) {
        setListener(firebase, dispatch, listener);
      }
    });
  }
}

/**
 * Unset previously set listener to Cloud Firestore. Listener must have been
 * set with setListener(s) in order to be tracked.
 * @param firebase - Internal firebase object
 * @param dispatch - Redux's dispatch function
 * @param meta - Metadata
 * @param meta.collection - Collection name
 * @param meta.doc - Document name
 * @return Resolves when listener has been attached **not** when data
 * has been gathered by the listener.
 */
export function unsetListener(firebase: any, dispatch: Dispatch, meta: QueryConfigObject): void {
  return detachListener(firebase, dispatch, getQueryConfig(meta));
}

/**
 * Unset a list of listeners
 * @param firebase - Internal firebase object
 * @param dispatch - Redux's dispatch function
 * @param listeners - Array of listener configs
 */
export function unsetListeners(firebase: any, dispatch: Dispatch, listeners: any[]): void {
  if (!isArray(listeners)) {
    throw new Error(
      'Listeners must be an Array of listener configs (Strings/Objects).',
    );
  }
  const { config } = firebase._;
  const { allowMultipleListeners } = config;

  // Keep one listener path even when detaching
  listeners.forEach(listener => {
    const path = getQueryName(listener);
    const listenerExists = pathListenerCounts[path] >= 1;
    const multipleListenersEnabled = isFunction(allowMultipleListeners)
      ? allowMultipleListeners(listener, firebase._.listeners)
      : allowMultipleListeners;

    if (listenerExists) {
      pathListenerCounts[path] -= 1;
      // If we aren't supposed to have listners for this path, then remove them
      if (pathListenerCounts[path] === 0 || multipleListenersEnabled) {
        unsetListener(firebase, dispatch, listener);
      }
    }
  });
}

/**
 * Atomic operation with Firestore (either read or write).
 * @param firebase - Internal firebase object
 * @param dispatch - Redux's dispatch function
 * @param transactionPromise - Function which runs transaction
 * operation.
 * @return Resolves with result of transaction operation
 */
export function runTransaction(firebase: any, dispatch: Dispatch, transactionPromise: any): Promise<any> {
  return wrapInDispatch(dispatch, {
    ref: firebase.firestore(),
    method: 'runTransaction',
    args: [transactionPromise],
    types: [
      actionTypes.TRANSACTION_START,
      actionTypes.TRANSACTION_SUCCESS,
      actionTypes.TRANSACTION_FAILURE,
    ],
  });
}