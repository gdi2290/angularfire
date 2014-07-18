(function() {
  'use strict';
  /**
   * Creates and maintains a synchronized list of data. This constructor should not be
   * manually invoked. Instead, one should create a $firebase object and call $asArray
   * on it:  <code>$firebase( firebaseRef ).$asArray()</code>;
   *
   * Internally, the $firebase object depends on this class to provide 5 methods, which it invokes
   * to notify the array whenever a change has been made at the server:
   *    $$added - called whenever a child_added event occurs
   *    $$updated - called whenever a child_changed event occurs
   *    $$moved - called whenever a child_moved event occurs
   *    $$removed - called whenever a child_removed event occurs
   *    $$error - called when listeners are canceled due to a security error
   *
   * Instead of directly modifying this class, one should generally use the $extendFactory
   * method to add or change how methods behave:
   *
   * <pre><code>
   * var NewFactory = $FirebaseArray.$extendFactory({
   *    // add a new method to the prototype
   *    foo: function() { return 'bar'; },
   *
   *    // change how records are created
   *    $$createRecord: function(snap) {
   *       return new Widget(snap);
   *    }
   * });
   * </code></pre>
   *
   * And then the new factory can be used by passing it as an argument:
   * <code>$firebase( firebaseRef, {arrayFactory: NewFactory}).$asObject();</code>
   */
  angular.module('firebase').factory('$FirebaseArray', ["$log", "$firebaseUtils",
    function($log, $firebaseUtils) {
      /**
       * This constructor should probably never be called manually. It is used internally by
       * <code>$firebase.$asArray()</code>.
       *
       * @param $firebase
       * @param {Function} destroyFn invoking this will cancel all event listeners and stop
       *                   notifications from being delivered to $$added, $$updated, $$moved, and $$removed
       * @returns {Array}
       * @constructor
       */
      function FirebaseArray($firebase, destroyFn) {
        // observers registered with the $watch function
        this._observers = [];
        // the synchronized list of records
        this.$list = [];
        this._inst = $firebase;
        // used by the $loaded() function
        this._promise = this._init();
        this._destroyFn = destroyFn;
        // Array.isArray will not work on objects which extend the Array class.
        // So instead of extending the Array class, we just return an actual array.
        // However, it's still possible to extend FirebaseArray and have the public methods
        // appear on the array object. We do this by iterating the prototype and binding
        // any method that is not prefixed with an underscore onto the final array.
        return this.$list;
      }

      FirebaseArray.prototype = {
        /**
         * Create a new record with a unique ID and add it to the end of the array.
         * This should be used instead of Array.prototype.push, since those changes will not be
         * synchronized with the server.
         *
         * Any value, including a primitive, can be added in this way. Note that when the record
         * is created, the primitive value would be stored in $value (records are always objects
         * by default).
         *
         * Returns a future which is resolved when the data has successfully saved to the server.
         * The resolve callback will be passed a Firebase ref representing the new data element.
         *
         * @param data
         * @returns a promise resolved after data is added
         */
        $add: function(data) {
          this._assertNotDestroyed('$add');
          return this.$inst().$push(data);
        },

        /**
         * Pass either an item in the array or the index of an item and it will be saved back
         * to Firebase. While the array is read-only and its structure should not be changed,
         * it is okay to modify properties on the objects it contains and then save those back
         * individually.
         *
         * Returns a future which is resolved when the data has successfully saved to the server.
         * The resolve callback will be passed a Firebase ref representing the saved element.
         * If passed an invalid index or an object which is not a record in this array,
         * the promise will be rejected.
         *
         * @param {int|object} indexOrItem
         * @returns a promise resolved after data is saved
         */
        $save: function(indexOrItem) {
          this._assertNotDestroyed('$save');
          var item = this._resolveItem(indexOrItem);
          var key = this.$keyAt(item);
          if( key !== null ) {
            return this.$inst().$set(key, $firebaseUtils.toJSON(item));
          }
          else {
            return $firebaseUtils.reject('Invalid record; could determine its key: '+indexOrItem);
          }
        },

        /**
         * Pass either an existing item in this array or the index of that item and it will
         * be removed both locally and in Firebase. This should be used in place of
         * Array.prototype.splice for removing items out of the array, as calling splice
         * will not update the value on the server.
         *
         * Returns a future which is resolved when the data has successfully removed from the
         * server. The resolve callback will be passed a Firebase ref representing the deleted
         * element. If passed an invalid index or an object which is not a record in this array,
         * the promise will be rejected.
         *
         * @param {int|object} indexOrItem
         * @returns a promise which resolves after data is removed
         */
        $remove: function(indexOrItem) {
          this._assertNotDestroyed('$remove');
          var key = this.$keyAt(indexOrItem);
          if( key !== null ) {
            return this.$inst().$remove(key);
          }
          else {
            return $firebaseUtils.reject('Invalid record; could not find key: '+indexOrItem);
          }
        },

        /**
         * Given an item in this array or the index of an item in the array, this returns the
         * Firebase key (record.$id) for that record. If passed an invalid key or an item which
         * does not exist in this array, it will return null.
         *
         * @param {int|object} indexOrItem
         * @returns {null|string}
         */
        $keyAt: function(indexOrItem) {
          var item = this._resolveItem(indexOrItem);
          return item === null? null : item.$id;
        },

        /**
         * The inverse of $keyAt, this method takes a Firebase key (record.$id) and returns the
         * index in the array where that record is stored. If the record is not in the array,
         * this method returns -1.
         *
         * @param {String} key
         * @returns {int} -1 if not found
         */
        $indexFor: function(key) {
          // todo optimize and/or cache these? they wouldn't need to be perfect
          return this.$list.findIndex(function(rec) { return rec.$id === key; });
        },

        /**
         * The loaded method is invoked after the initial batch of data arrives from the server.
         * When this resolves, all data which existed prior to calling $asArray() is now cached
         * locally in the array.
         *
         * As a shortcut is also possible to pass resolve/reject methods directly into this
         * method just as they would be passed to .then()
         *
         * @param {Function} [resolve]
         * @param {Function} [reject]
         * @returns a promise
         */
        $loaded: function(resolve, reject) {
          var promise = this._promise;
          if( arguments.length ) {
            promise = promise.then.apply(promise, arguments);
          }
          return promise;
        },

        /**
         * @returns the original $firebase object used to create this object.
         */
        $inst: function() { return this._inst; },

        /**
         * Listeners passed into this method are notified whenever a new change (add, updated,
         * move, remove) is received from the server. Each invocation is sent an object
         * containing <code>{ type: 'added|updated|moved|removed', key: 'key_of_item_affected'}</code>
         *
         * Additionally, added and moved events receive a prevChild parameter, containing the
         * key of the item before this one in the array.
         *
         * @param {Function} cb
         * @param {Object} [context]
         * @returns {Function}
         */
        $watch: function(cb, context) {
          var list = this._observers;
          list.push([cb, context]);
          // an off function for cancelling the listener
          return function() {
            var i = list.findIndex(function(parts) {
              return parts[0] === cb && parts[1] === context;
            });
            if( i > -1 ) {
              list.splice(i, 1);
            }
          };
        },

        /**
         * Informs $firebase to stop sending events to this object and clears memory being used
         * by this array (delete's its local content).
         */
        $destroy: function() {
          if( !this._isDestroyed ) {
            this._isDestroyed = true;
            this.$list.length = 0;
            $log.debug('destroy called for FirebaseArray: '+this.$inst().$ref().toString());
            this._destroyFn();
          }
        },

        /**
         * Returns the record for a given Firebase key (record.$id). If the record is not found
         * then returns null.
         *
         * @param {string} key
         * @returns {Object|null} a record in this array
         */
        $getRecord: function(key) {
          var i = this.$indexFor(key);
          return i > -1? this.$list[i] : null;
        },

        /**
         * This method is used internally by $$added to create new records before inserting
         * them into the array. This creates a simple way to modify the initial object creation
         * process without having to implement all the functionality of $$added. This method
         * is not part of the contract provided by $firebase.$asObject() and is only used internally.
         *
         * @param snap a firebase snapshot
         * @returns {object}
         */
        $$createRecord: function(snap) {
          var data = snap.val();
          if( !angular.isObject(data) ) {
            data = { $value: data };
          }
          data.$id = snap.name();
          data.$priority = snap.getPriority();
          return data;
        },

        /**
         * Called by $firebase to inform the array when a new item has been added at the server.
         * This method must exist on any array factory used by $firebase.
         *
         * @param snap
         * @param {string} prevChild
         */
        $$added: function(snap, prevChild) {
          var rec = this.$getRecord(snap.name());
          if( !rec ) {
            // get the new record object
            rec = this.$$createRecord(snap);
            // add it to the array
            this._addAfter(rec, prevChild);
            // send notifications to anybody monitoring $watch
            this._notify('child_added', snap.name(), prevChild);
          }
        },

        /**
         * Called by $firebase whenever an item is removed at the server.
         * This method must exist on any array factory used by $firebase.
         *
         * @param snap
         */
        $$removed: function(snap) {
          // remove record from the array
          var rec = this._spliceOut(snap.name());
          if( angular.isDefined(rec) ) {
            // if it was found, send notifications
            this._notify('child_removed', snap.name());
          }
        },

        /**
         * Called by $firebase whenever an item is changed at the server.
         * This method must exist on any array factory used by $firebase.
         *
         * @param snap
         */
        $$updated: function(snap) {
          // find the record
          var rec = this.$getRecord(snap.name());
          if( angular.isObject(rec) ) {
            // apply changes to the record
            var changed = $firebaseUtils.updateRec(rec, snap);
            if( changed ) {
              // if something actually changed, notify listeners of $watch
              this._notify('child_changed', snap.name());
            }
          }
        },

        /**
         * Called by $firebase whenever an item changes order (moves) on the server.
         * This method must exist on any array factory used by $firebase.
         *
         * @param snap
         * @param {string} prevChild
         */
        $$moved: function(snap, prevChild) {
          // take record out of the array
          var dat = this._spliceOut(snap.name());
          if( angular.isDefined(dat) ) {
            // if it was found, put it back in the new location
            this._addAfter(dat, prevChild);
            // notify listeners of $watch
            this._notify('child_moved', snap.name(), prevChild);
          }
        },

        /**
         * Called whenever a security error or other problem causes the listeners to become
         * invalid. This is generally an unrecoverable error.
         * @param {Object} err which will have a `code` property and possibly a `message`
         */
        $$error: function(err) {
          $log.error(err);
          this.$destroy(err);
        },

        /**
         * Used to trigger notifications for listeners registered using $watch
         * @param {string} event
         * @param {string} key
         * @param {string} [prevChild]
         * @private
         */
        _notify: function(event, key, prevChild) {
          var eventData = {event: event, key: key};
          if( arguments.length === 3 ) {
            eventData.prevChild = prevChild;
          }
          angular.forEach(this._observers, function(parts) {
            parts[0].call(parts[1], eventData);
          });
        },

        /**
         * Used to insert a new record into the array at a specific position. If prevChild is
         * null, is inserted first, if prevChild is not found, it is inserted last, otherwise,
         * it goes immediately after prevChild.
         *
         * @param {object} rec
         * @param {string|null} prevChild
         * @private
         */
        _addAfter: function(rec, prevChild) {
          var i;
          if( prevChild === null ) {
            i = 0;
          }
          else {
            i = this.$indexFor(prevChild)+1;
            if( i === 0 ) { i = this.$list.length; }
          }
          this.$list.splice(i, 0, rec);
        },

        /**
         * Removes a record from the array by calling splice. If the item is found
         * this method returns it. Otherwise, this method returns null.
         *
         * @param {string} key
         * @returns {object|null}
         * @private
         */
        _spliceOut: function(key) {
          var i = this.$indexFor(key);
          if( i > -1 ) {
            return this.$list.splice(i, 1)[0];
          }
          return null;
        },

        /**
         * Resolves a variable which may contain an integer or an item that exists in this array.
         * Returns the item or null if it does not exist.
         *
         * @param indexOrItem
         * @returns {*}
         * @private
         */
        _resolveItem: function(indexOrItem) {
          var list = this.$list;
          if( angular.isNumber(indexOrItem) && indexOrItem >= 0 && list.length >= indexOrItem ) {
            return list[indexOrItem];
          }
          else if( angular.isObject(indexOrItem) ) {
            var i = list.length;
            while(i--) {
              if( list[i] === indexOrItem ) {
                return indexOrItem;
              }
            }
          }
          return null;
        },

        /**
         * Throws an error if $destroy has been called. Should be used for any function
         * which tries to write data back to $firebase.
         * @param {string} method
         * @private
         */
        _assertNotDestroyed: function(method) {
          if( this._isDestroyed ) {
            throw new Error('Cannot call ' + method + ' method on a destroyed $FirebaseArray object');
          }
        },

        /**
         * Copies our prototype onto the actual array element and preps our $loaded() promise
         *
         * @returns a promise that resolves after initial data is loaded
         * @private
         */
        _init: function() {
          var self = this;
          var list = self.$list;
          var def = $firebaseUtils.defer();
          var ref = self.$inst().$ref();

          // we return $list, but apply our public prototype to it first
          // see FirebaseArray.prototype's assignment comments
          $firebaseUtils.getPublicMethods(self, function(fn, key) {
            list[key] = fn.bind(self);
          });

          // for our $loaded() function
          // this is guaranteed by Firebase to trigger after any child_added events for
          // data which already existed when this snapshot was taken, thus, it's a convenient
          // way to decide when all existing records have come down from the server
          ref.once('value', function() {
            $firebaseUtils.compile(function() {
              if( self._isDestroyed ) {
                def.reject('instance was destroyed before load completed');
              }
              else {
                def.resolve(list);
              }
            });
          }, def.reject.bind(def));

          return def.promise;
        }
      };

      /**
       * This method allows FirebaseArray to be copied into a new factory. Methods passed into this
       * function will be added onto the array's prototype. They can override existing methods as
       * well.
       *
       * In addition to passing additional methods, it is also possible to pass in a class function.
       * The prototype on that class function will be preserved, and it will inherit from
       * FirebaseArray. It's also possible to do both, passing a class to inherit and additional
       * methods to add onto the prototype.
       *
       * Once a factory is obtained by this method, it can be passed into $firebase as the
       * `arrayFactory` parameter:
       * <pre><code>
       * var MyFactory = $FirebaseArray.$extendFactory({
       *    // add a method onto the prototype that sums all items in the array
       *    getSum: function() {
       *       var ct = 0;
       *       angular.forEach(this.$list, function(rec) { ct += rec.x; });
        *      return ct;
       *    }
       * });
       *
       * // use our new factory in place of $FirebaseArray
       * var list = $firebase(ref, {arrayFactory: MyFactory}).$asArray();
       * </code></pre>
       *
       * @param {Function} [ChildClass] a child class which should inherit FirebaseArray
       * @param {Object} [methods] a list of functions to add onto the prototype
       * @returns {Function} a new factory suitable for use with $firebase
       */
      FirebaseArray.$extendFactory = function(ChildClass, methods) {
        if( arguments.length === 1 && angular.isObject(ChildClass) ) {
          methods = ChildClass;
          ChildClass = function() { return FirebaseArray.apply(this, arguments); };
        }
        return $firebaseUtils.inherit(ChildClass, FirebaseArray, methods);
      };

      return FirebaseArray;
    }
  ]);
})();