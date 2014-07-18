/*!
 angularfire v0.8.0-pre2 2014-07-17
* https://github.com/firebase/angularFire
* Copyright (c) 2014 Firebase, Inc.
* MIT LICENSE: http://firebase.mit-license.org/
*/

// AngularFire is an officially supported AngularJS binding for Firebase.
// The bindings let you associate a Firebase URL with a model (or set of
// models), and they will be transparently kept in sync across all clients
// currently using your app. The 2-way data binding offered by AngularJS works
// as normal, except that the changes are also sent to all other clients
// instead of just a server.
(function(exports) {
  "use strict";

// Define the `firebase` module under which all AngularFire
// services will live.
  angular.module("firebase", [])
    .value("Firebase", exports.Firebase)

    // used in conjunction with firebaseUtils.debounce function, this is the
    // amount of time we will wait for additional records before triggering
    // Angular's digest scope to dirty check and re-render DOM elements. A
    // larger number here significantly improves performance when working with
    // big data sets that are frequently changing in the DOM, but delays the
    // speed at which each record is rendered in real-time. A number less than
    // 100ms will usually be optimal.
    .value('firebaseBatchDelay', 50 /* milliseconds */);

})(window);
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
       * @param {$firebase} $firebase
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
         *
         * @param data
         * @returns {*}
         */
        $add: function(data) {
          this._assertNotDestroyed('$add');
          return this.$inst().$push(data);
        },

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

        $remove: function(indexOrItem) {
          this._assertNotDestroyed('$remove');
          var key = this.$keyAt(indexOrItem);
          if( key !== null ) {
            return this.$inst().$remove(this.$keyAt(indexOrItem));
          }
          else {
            return $firebaseUtils.reject('Invalid record; could not find key: '+indexOrItem);
          }
        },

        $keyAt: function(indexOrItem) {
          var item = this._resolveItem(indexOrItem);
          return angular.isUndefined(item) || angular.isUndefined(item.$id)? null : item.$id;
        },

        $indexFor: function(key) {
          // todo optimize and/or cache these? they wouldn't need to be perfect
          return this.$list.findIndex(function(rec) { return rec.$id === key; });
        },

        $loaded: function() {
          var promise = this._promise;
          if( arguments.length ) {
            promise = promise.then.apply(promise, arguments);
          }
          return promise;
        },

        $inst: function() { return this._inst; },

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

        $destroy: function() {
          if( !this._isDestroyed ) {
            this._isDestroyed = true;
            this.$list.length = 0;
            $log.debug('destroy called for FirebaseArray: '+this.$inst().$ref().toString());
            this._destroyFn();
          }
        },

        $getRecord: function(key) {
          var i = this.$indexFor(key);
          return i > -1? this.$list[i] : null;
        },

        $$createRecord: function(snap) {
          var data = snap.val();
          if( !angular.isObject(data) ) {
            data = { $value: data };
          }
          data.$id = snap.name();
          data.$priority = snap.getPriority();
          return data;
        },

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

        $$removed: function(snap) {
          // remove record from the array
          var rec = this._spliceOut(snap.name());
          if( angular.isDefined(rec) ) {
            // if it was found, send notifications
            this._notify('child_removed', snap.name());
          }
        },

        $$updated: function(snap) {
          throw new Error('oops');
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

        $$error: function(err) {
          $log.error(err);
          this.$destroy(err);
        },

        _notify: function(event, key, prevChild) {
          var eventData = {event: event, key: key};
          if( arguments.length === 3 ) {
            eventData.prevChild = prevChild;
          }
          angular.forEach(this._observers, function(parts) {
            parts[0].call(parts[1], eventData);
          });
        },

        _addAfter: function(dat, prevChild) {
          var i;
          if( prevChild === null ) {
            i = 0;
          }
          else {
            i = this.$indexFor(prevChild)+1;
            if( i === 0 ) { i = this.$list.length; }
          }
          this.$list.splice(i, 0, dat);
        },

        _spliceOut: function(key) {
          var i = this.$indexFor(key);
          if( i > -1 ) {
            return this.$list.splice(i, 1)[0];
          }
        },

        _resolveItem: function(indexOrItem) {
          return angular.isNumber(indexOrItem)? this.$list[indexOrItem] : indexOrItem;
        },

        _assertNotDestroyed: function(method) {
          if( this._isDestroyed ) {
            throw new Error('Cannot call ' + method + ' method on a destroyed $FirebaseArray object');
          }
        },

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
(function() {
  'use strict';
  angular.module('firebase').factory('$FirebaseObject', [
    '$parse', '$firebaseUtils', '$log',
    function($parse, $firebaseUtils, $log) {
      function FirebaseObject($firebase, destroyFn) {
        var self = this, def = $firebaseUtils.defer();
        self.$$conf = {
          promise: def.promise,
          inst: $firebase,
          bound: null,
          destroyFn: destroyFn,
          listeners: [],
          updated: function() {
            if( self.$$conf.bound ) {
              self.$$conf.bound.update();
            }
            angular.forEach(self.$$conf.listeners, function (parts) {
              parts[0].call(parts[1], {event: 'updated', key: self.$id});
            });
          }
        };

        self.$id = $firebase.$ref().name();
        self.$data = {};
        self.$priority = null;
        self.$$conf.inst.$ref().once('value',
          function() {
            $firebaseUtils.compile(def.resolve.bind(def, self));
          },
          function(err) {
            $firebaseUtils.compile(def.reject.bind(def, err));
          }
        );
      }

      FirebaseObject.prototype = {
        $save: function () {
          return this.$inst().$set($firebaseUtils.toJSON(this));
        },

        $loaded: function () {
          var promise = this.$$conf.promise;
          if (arguments.length) {
            // allow this method to be called just like .then
            // by passing any arguments on to .then
            promise = promise.then.apply(promise, arguments);
          }
          return promise;
        },

        $inst: function () {
          return this.$$conf.inst;
        },

        $bindTo: function (scope, varName) {
          var self = this;
          return self.$loaded().then(function () {
            if (self.$$conf.bound) {
              throw new Error('Can only bind to one scope variable at a time');
            }

            var unbind = function () {
              if (self.$$conf.bound) {
                self.$$conf.bound = null;
                off();
              }
            };

            // expose a few useful methods to other methods
            var parsed = $parse(varName);
            var $bound = self.$$conf.bound = {
              update: function() {
                var curr = $bound.get();
                if( !angular.isObject(curr) ) {
                  curr = {};
                }
                $firebaseUtils.each(self, function(v,k) {
                  curr[k] = v;
                });
                curr.$id = self.$id;
                curr.$priority = self.$priority;
                if( self.hasOwnProperty('$value') ) {
                  curr.$value = self.$value;
                }
                parsed.assign(scope, curr);
              },
              get: function () {
                return parsed(scope);
              },
              unbind: unbind
            };

            $bound.update();
            scope.$on('$destroy', $bound.unbind);

            // monitor scope for any changes
            var off = scope.$watch(varName, function () {
              var newData = $firebaseUtils.toJSON($bound.get());
              var oldData = $firebaseUtils.toJSON(self);
              if (!angular.equals(newData, oldData)) {
                self.$inst().$set(newData);
              }
            }, true);

            return unbind;
          });
        },

        $watch: function (cb, context) {
          var list = this.$$conf.listeners;
          list.push([cb, context]);
          // an off function for cancelling the listener
          return function () {
            var i = list.findIndex(function (parts) {
              return parts[0] === cb && parts[1] === context;
            });
            if (i > -1) {
              list.splice(i, 1);
            }
          };
        },

        $destroy: function () {
          var self = this;
          if (!self.$isDestroyed) {
            self.$isDestroyed = true;
            self.$$conf.destroyFn();
            if (self.$$conf.bound) {
              self.$$conf.bound.unbind();
            }
            $firebaseUtils.each(self, function (v, k) {
              delete self[k];
            });
          }
        },

        $$updated: function (snap) {
          this.$id = snap.name();
          // applies new data to this object
          var changed = $firebaseUtils.updateRec(this, snap);
          if( changed ) {
            // notifies $watch listeners and
            // updates $scope if bound to a variable
            this.$$conf.updated();
          }
        },

        $$error: function (err) {
          $log.error(err);
          this.$destroy();
        }
      };

      FirebaseObject.$extendFactory = function(ChildClass, methods) {
        if( arguments.length === 1 && angular.isObject(ChildClass) ) {
          methods = ChildClass;
          ChildClass = function() { FirebaseObject.apply(this, arguments); };
        }
        return $firebaseUtils.inherit(ChildClass, FirebaseObject, methods);
      };

      return FirebaseObject;
    }
  ]);
})();
(function() {
  'use strict';

  angular.module("firebase")

    // The factory returns an object containing the value of the data at
    // the Firebase location provided, as well as several methods. It
    // takes one or two arguments:
    //
    //   * `ref`: A Firebase reference. Queries or limits may be applied.
    //   * `config`: An object containing any of the advanced config options explained in API docs
    .factory("$firebase", [ "$firebaseUtils", "$firebaseConfig",
      function ($firebaseUtils, $firebaseConfig) {
        function AngularFire(ref, config) {
          // make the new keyword optional
          if (!(this instanceof AngularFire)) {
            return new AngularFire(ref, config);
          }
          this._config = $firebaseConfig(config);
          this._ref = ref;
          this._arraySync = null;
          this._objectSync = null;
          this._assertValidConfig(ref, this._config);
        }

        AngularFire.prototype = {
          $ref: function () {
            return this._ref;
          },

          $push: function (data) {
            var def = $firebaseUtils.defer();
            var ref = this._ref.ref().push();
            var done = this._handle(def, ref);
            if (arguments.length > 0) {
              ref.set(data, done);
            }
            else {
              done();
            }
            return def.promise;
          },

          $set: function (key, data) {
            var ref = this._ref.ref();
            var def = $firebaseUtils.defer();
            if (arguments.length > 1) {
              ref = ref.child(key);
            }
            else {
              data = key;
            }
            ref.set(data, this._handle(def, ref));
            return def.promise;
          },

          $remove: function (key) {
            //todo is this the best option? should remove blow away entire
            //todo data set if we are operating on a query result? probably
            //todo not; instead, we should probably forEach the results and
            //todo remove them individually
            //todo https://github.com/firebase/angularFire/issues/325
            var ref = this._ref.ref();
            var def = $firebaseUtils.defer();
            if (arguments.length > 0) {
              ref = ref.child(key);
            }
            ref.remove(this._handle(def, ref));
            return def.promise;
          },

          $update: function (key, data) {
            var ref = this._ref.ref();
            var def = $firebaseUtils.defer();
            if (arguments.length > 1) {
              ref = ref.child(key);
            }
            else {
              data = key;
            }
            ref.update(data, this._handle(def, ref));
            return def.promise;
          },

          $transaction: function (key, valueFn, applyLocally) {
            var ref = this._ref.ref();
            if( angular.isFunction(key) ) {
              applyLocally = valueFn;
              valueFn = key;
            }
            else {
              ref = ref.child(key);
            }
            if( angular.isUndefined(applyLocally) ) {
              applyLocally = false;
            }

            var def = $firebaseUtils.defer();
            ref.transaction(valueFn, function(err, committed, snap) {
               if( err ) {
                 def.reject(err);
               }
               else {
                 def.resolve(committed? snap : null);
               }
            }, applyLocally);
            return def.promise;
          },

          $asObject: function () {
            if (!this._objectSync || this._objectSync.isDestroyed) {
              this._objectSync = new SyncObject(this, this._config.objectFactory);
            }
            return this._objectSync.getObject();
          },

          $asArray: function () {
            if (!this._arraySync || this._arraySync.isDestroyed) {
              this._arraySync = new SyncArray(this, this._config.arrayFactory);
            }
            return this._arraySync.getArray();
          },

          _handle: function (def) {
            var args = Array.prototype.slice.call(arguments, 1);
            return function (err) {
              if (err) {
                def.reject(err);
              }
              else {
                def.resolve.apply(def, args);
              }
            };
          },

          _assertValidConfig: function (ref, cnf) {
            $firebaseUtils.assertValidRef(ref, 'Must pass a valid Firebase reference ' +
              'to $firebase (not a string or URL)');
            if (!angular.isFunction(cnf.arrayFactory)) {
              throw new Error('config.arrayFactory must be a valid function');
            }
            if (!angular.isFunction(cnf.objectFactory)) {
              throw new Error('config.arrayFactory must be a valid function');
            }
          }
        };

        function SyncArray($inst, ArrayFactory) {
          function destroy() {
            self.isDestroyed = true;
            var ref = $inst.$ref();
            ref.off('child_added', created);
            ref.off('child_moved', moved);
            ref.off('child_changed', updated);
            ref.off('child_removed', removed);
            array = null;
          }

          function init() {
            var ref = $inst.$ref();

            // listen for changes at the Firebase instance
            ref.on('child_added', created, error);
            ref.on('child_moved', moved, error);
            ref.on('child_changed', updated, error);
            ref.on('child_removed', removed, error);
          }

          var array = new ArrayFactory($inst, destroy);
          var batch = $firebaseUtils.batch();
          var created = batch(array.$$added, array);
          var updated = batch(array.$$updated, array);
          var moved = batch(array.$$moved, array);
          var removed = batch(array.$$removed, array);
          var error = batch(array.$$error, array);

          var self = this;
          self.isDestroyed = false;
          self.getArray = function() { return array; };
          init();
        }

        function SyncObject($inst, ObjectFactory) {
          function destroy() {
            self.isDestroyed = true;
            ref.off('value', applyUpdate);
            obj = null;
          }

          function init() {
            ref.on('value', applyUpdate, error);
          }

          var obj = new ObjectFactory($inst, destroy);
          var ref = $inst.$ref();
          var batch = $firebaseUtils.batch();
          var applyUpdate = batch(obj.$$updated, obj);
          var error = batch(obj.$$error, obj);

          var self = this;
          self.isDestroyed = false;
          self.getObject = function() { return obj; };
          init();
        }

        return AngularFire;
      }
    ]);
})();
(function() {
  'use strict';
  var AngularFireAuth;

  // Defines the `$firebaseSimpleLogin` service that provides simple
  // user authentication support for AngularFire.
  angular.module("firebase").factory("$firebaseSimpleLogin", [
    "$q", "$timeout", "$rootScope", function($q, $t, $rs) {
      // The factory returns an object containing the authentication state
      // of the current user. This service takes one argument:
      //
      //   * `ref`     : A Firebase reference.
      //
      // The returned object has the following properties:
      //
      //  * `user`: Set to "null" if the user is currently logged out. This
      //    value will be changed to an object when the user successfully logs
      //    in. This object will contain details of the logged in user. The
      //    exact properties will vary based on the method used to login, but
      //    will at a minimum contain the `id` and `provider` properties.
      //
      // The returned object will also have the following methods available:
      // $login(), $logout(), $createUser(), $changePassword(), $removeUser(),
      // and $getCurrentUser().
      return function(ref) {
        var auth = new AngularFireAuth($q, $t, $rs, ref);
        return auth.construct();
      };
    }
  ]);

  AngularFireAuth = function($q, $t, $rs, ref) {
    this._q = $q;
    this._timeout = $t;
    this._rootScope = $rs;
    this._loginDeferred = null;
    this._getCurrentUserDeferred = [];
    this._currentUserData = undefined;

    if (typeof ref == "string") {
      throw new Error("Please provide a Firebase reference instead " +
        "of a URL, eg: new Firebase(url)");
    }
    this._fRef = ref;
  };

  AngularFireAuth.prototype = {
    construct: function() {
      var object = {
        user: null,
        $login: this.login.bind(this),
        $logout: this.logout.bind(this),
        $createUser: this.createUser.bind(this),
        $changePassword: this.changePassword.bind(this),
        $removeUser: this.removeUser.bind(this),
        $getCurrentUser: this.getCurrentUser.bind(this),
        $sendPasswordResetEmail: this.sendPasswordResetEmail.bind(this)
      };
      this._object = object;

      // Initialize Simple Login.
      if (!window.FirebaseSimpleLogin) {
        var err = new Error("FirebaseSimpleLogin is undefined. " +
          "Did you forget to include firebase-simple-login.js?");
        this._rootScope.$broadcast("$firebaseSimpleLogin:error", err);
        throw err;
      }

      var client = new FirebaseSimpleLogin(this._fRef,
        this._onLoginEvent.bind(this));
      this._authClient = client;
      return this._object;
    },

    // The login method takes a provider (for Simple Login) and authenticates
    // the Firebase reference with which the service was initialized. This
    // method returns a promise, which will be resolved when the login succeeds
    // (and rejected when an error occurs).
    login: function(provider, options) {
      var deferred = this._q.defer();
      var self = this;

      // To avoid the promise from being fulfilled by our initial login state,
      // make sure we have it before triggering the login and creating a new
      // promise.
      this.getCurrentUser().then(function() {
        self._loginDeferred = deferred;
        self._authClient.login(provider, options);
      });

      return deferred.promise;
    },

    // Unauthenticate the Firebase reference.
    logout: function() {
      // Tell the simple login client to log us out.
      this._authClient.logout();

      // Forget who we were, so that any getCurrentUser calls will wait for
      // another user event.
      delete this._currentUserData;
    },

    // Creates a user for Firebase Simple Login. Function 'cb' receives an
    // error as the first argument and a Simple Login user object as the second
    // argument. Note that this function only creates the user, if you wish to
    // log in as the newly created user, call $login() after the promise for
    // this method has been fulfilled.
    createUser: function(email, password) {
      var self = this;
      var deferred = this._q.defer();

      self._authClient.createUser(email, password, function(err, user) {
        if (err) {
          self._rootScope.$broadcast("$firebaseSimpleLogin:error", err);
          deferred.reject(err);
        } else {
          deferred.resolve(user);
        }
      });

      return deferred.promise;
    },

    // Changes the password for a Firebase Simple Login user. Take an email,
    // old password and new password as three mandatory arguments. Returns a
    // promise.
    changePassword: function(email, oldPassword, newPassword) {
      var self = this;
      var deferred = this._q.defer();

      self._authClient.changePassword(email, oldPassword, newPassword,
        function(err) {
          if (err) {
            self._rootScope.$broadcast("$firebaseSimpleLogin:error", err);
            deferred.reject(err);
          } else {
            deferred.resolve();
          }
        }
      );

      return deferred.promise;
    },

    // Gets a promise for the current user info.
    getCurrentUser: function() {
      var self = this;
      var deferred = this._q.defer();

      if (self._currentUserData !== undefined) {
        deferred.resolve(self._currentUserData);
      } else {
        self._getCurrentUserDeferred.push(deferred);
      }

      return deferred.promise;
    },

    // Remove a user for the listed email address. Returns a promise.
    removeUser: function(email, password) {
      var self = this;
      var deferred = this._q.defer();

      self._authClient.removeUser(email, password, function(err) {
        if (err) {
          self._rootScope.$broadcast("$firebaseSimpleLogin:error", err);
          deferred.reject(err);
        } else {
          deferred.resolve();
        }
      });

      return deferred.promise;
    },

    // Send a password reset email to the user for an email + password account.
    sendPasswordResetEmail: function(email) {
      var self = this;
      var deferred = this._q.defer();

      self._authClient.sendPasswordResetEmail(email, function(err) {
        if (err) {
          self._rootScope.$broadcast("$firebaseSimpleLogin:error", err);
          deferred.reject(err);
        } else {
          deferred.resolve();
        }
      });

      return deferred.promise;
    },

    // Internal callback for any Simple Login event.
    _onLoginEvent: function(err, user) {
      // HACK -- calls to logout() trigger events even if we're not logged in,
      // making us get extra events. Throw them away. This should be fixed by
      // changing Simple Login so that its callbacks refer directly to the
      // action that caused them.
      if (this._currentUserData === user && err === null) {
        return;
      }

      var self = this;
      if (err) {
        if (self._loginDeferred) {
          self._loginDeferred.reject(err);
          self._loginDeferred = null;
        }
        self._rootScope.$broadcast("$firebaseSimpleLogin:error", err);
      } else {
        this._currentUserData = user;

        self._timeout(function() {
          self._object.user = user;
          if (user) {
            self._rootScope.$broadcast("$firebaseSimpleLogin:login", user);
          } else {
            self._rootScope.$broadcast("$firebaseSimpleLogin:logout");
          }
          if (self._loginDeferred) {
            self._loginDeferred.resolve(user);
            self._loginDeferred = null;
          }
          while (self._getCurrentUserDeferred.length > 0) {
            var def = self._getCurrentUserDeferred.pop();
            def.resolve(user);
          }
        });
      }
    }
  };
})();
'use strict';

// Shim Array.indexOf for IE compatibility.
if (!Array.prototype.indexOf) {
  Array.prototype.indexOf = function (searchElement, fromIndex) {
    if (this === undefined || this === null) {
      throw new TypeError("'this' is null or not defined");
    }
    // Hack to convert object.length to a UInt32
    // jshint -W016
    var length = this.length >>> 0;
    fromIndex = +fromIndex || 0;
    // jshint +W016

    if (Math.abs(fromIndex) === Infinity) {
      fromIndex = 0;
    }

    if (fromIndex < 0) {
      fromIndex += length;
      if (fromIndex < 0) {
        fromIndex = 0;
      }
    }

    for (;fromIndex < length; fromIndex++) {
      if (this[fromIndex] === searchElement) {
        return fromIndex;
      }
    }

    return -1;
  };
}

// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Function/bind
if (!Function.prototype.bind) {
  Function.prototype.bind = function (oThis) {
    if (typeof this !== "function") {
      // closest thing possible to the ECMAScript 5
      // internal IsCallable function
      throw new TypeError("Function.prototype.bind - what is trying to be bound is not callable");
    }

    var aArgs = Array.prototype.slice.call(arguments, 1),
      fToBind = this,
      fNOP = function () {},
      fBound = function () {
        return fToBind.apply(this instanceof fNOP && oThis
            ? this
            : oThis,
          aArgs.concat(Array.prototype.slice.call(arguments)));
      };

    fNOP.prototype = this.prototype;
    fBound.prototype = new fNOP();

    return fBound;
  };
}

// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/findIndex
if (!Array.prototype.findIndex) {
  Object.defineProperty(Array.prototype, 'findIndex', {
    enumerable: false,
    configurable: true,
    writable: true,
    value: function(predicate) {
      if (this == null) {
        throw new TypeError('Array.prototype.find called on null or undefined');
      }
      if (typeof predicate !== 'function') {
        throw new TypeError('predicate must be a function');
      }
      var list = Object(this);
      var length = list.length >>> 0;
      var thisArg = arguments[1];
      var value;

      for (var i = 0; i < length; i++) {
        if (i in list) {
          value = list[i];
          if (predicate.call(thisArg, value, i, list)) {
            return i;
          }
        }
      }
      return -1;
    }
  });
}

// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/create
if (typeof Object.create != 'function') {
  (function () {
    var F = function () {};
    Object.create = function (o) {
      if (arguments.length > 1) {
        throw new Error('Second argument not supported');
      }
      if (o === null) {
        throw new Error('Cannot set a null [[Prototype]]');
      }
      if (typeof o != 'object') {
        throw new TypeError('Argument must be an object');
      }
      F.prototype = o;
      return new F();
    };
  })();
}

// From https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/keys
if (!Object.keys) {
  Object.keys = (function () {
    'use strict';
    var hasOwnProperty = Object.prototype.hasOwnProperty,
      hasDontEnumBug = !({toString: null}).propertyIsEnumerable('toString'),
      dontEnums = [
        'toString',
        'toLocaleString',
        'valueOf',
        'hasOwnProperty',
        'isPrototypeOf',
        'propertyIsEnumerable',
        'constructor'
      ],
      dontEnumsLength = dontEnums.length;

    return function (obj) {
      if (typeof obj !== 'object' && (typeof obj !== 'function' || obj === null)) {
        throw new TypeError('Object.keys called on non-object');
      }

      var result = [], prop, i;

      for (prop in obj) {
        if (hasOwnProperty.call(obj, prop)) {
          result.push(prop);
        }
      }

      if (hasDontEnumBug) {
        for (i = 0; i < dontEnumsLength; i++) {
          if (hasOwnProperty.call(obj, dontEnums[i])) {
            result.push(dontEnums[i]);
          }
        }
      }
      return result;
    };
  }());
}

// http://ejohn.org/blog/objectgetprototypeof/
if ( typeof Object.getPrototypeOf !== "function" ) {
  if ( typeof "test".__proto__ === "object" ) {
    Object.getPrototypeOf = function(object){
      return object.__proto__;
    };
  } else {
    Object.getPrototypeOf = function(object){
      // May break if the constructor has been tampered with
      return object.constructor.prototype;
    };
  }
}

(function() {
  'use strict';

  angular.module('firebase')
    .factory('$firebaseConfig', ["$FirebaseArray", "$FirebaseObject",
      function($FirebaseArray, $FirebaseObject) {
        return function(configOpts) {
          return angular.extend({
            arrayFactory: $FirebaseArray,
            objectFactory: $FirebaseObject
          }, configOpts);
        };
      }
    ])

    .factory('$firebaseUtils', ["$q", "$timeout", "firebaseBatchDelay",
      function($q, $timeout, firebaseBatchDelay) {
        function batch(wait, maxWait) {
          if( !wait ) { wait = angular.isDefined(wait)? wait : firebaseBatchDelay; }
          if( !maxWait ) { maxWait = wait*10 || 100; }
          var list = [];
          var start;
          var timer;

          function addToBatch(fn, context) {
             if( typeof(fn) !== 'function' ) {
               throw new Error('Must provide a function to be batched. Got '+fn);
             }
             return function() {
               var args = Array.prototype.slice.call(arguments, 0);
               list.push([fn, context, args]);
               resetTimer();
             };
          }
          
          function resetTimer() {
            if( timer ) {
              clearTimeout(timer);
            }
            if( start && Date.now() - start > maxWait ) {
              compile(runNow);
            }
            else {
              if( !start ) { start = Date.now(); }
              timer = compile(runNow, wait);
            }
          }

          function runNow() {
            timer = null;
            start = null;
            var copyList = list.slice(0);
            list = [];
            angular.forEach(copyList, function(parts) {
              parts[0].apply(parts[1], parts[2]);
            });
          }

          return addToBatch;
        }

        function assertValidRef(ref, msg) {
          if( !angular.isObject(ref) ||
            typeof(ref.ref) !== 'function' ||
            typeof(ref.ref().transaction) !== 'function' ) {
            throw new Error(msg || 'Invalid Firebase reference');
          }
        }

        // http://stackoverflow.com/questions/7509831/alternative-for-the-deprecated-proto
        // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/create
        function inherit(ChildClass, ParentClass, methods) {
          var childMethods = ChildClass.prototype;
          ChildClass.prototype = Object.create(ParentClass.prototype);
          ChildClass.prototype.constructor = ChildClass; // restoring proper constructor for child class
          angular.forEach(Object.keys(childMethods), function(k) {
            ChildClass.prototype[k] = childMethods[k];
          });
          if( angular.isObject(methods) ) {
            angular.extend(ChildClass.prototype, methods);
          }
          return ChildClass;
        }

        function getPrototypeMethods(inst, iterator, context) {
          var methods = {};
          var objProto = Object.getPrototypeOf({});
          var proto = angular.isFunction(inst) && angular.isObject(inst.prototype)?
            inst.prototype : Object.getPrototypeOf(inst);
          while(proto && proto !== objProto) {
            for (var key in proto) {
              // we only invoke each key once; if a super is overridden it's skipped here
              if (proto.hasOwnProperty(key) && !methods.hasOwnProperty(key)) {
                methods[key] = true;
                iterator.call(context, proto[key], key, proto);
              }
            }
            proto = Object.getPrototypeOf(proto);
          }
        }

        function getPublicMethods(inst, iterator, context) {
          getPrototypeMethods(inst, function(m, k) {
            if( typeof(m) === 'function' && k.charAt(0) !== '_' ) {
              iterator.call(context, m, k);
            }
          });
        }

        function defer() {
          return $q.defer();
        }

        function reject(msg) {
          var def = defer();
          def.reject(msg);
          return def.promise;
        }

        function compile(fn, wait) {
          $timeout(fn||function() {}, wait||0);
        }

        function updateRec(rec, snap) {
          var data = snap.val();
          var oldData = angular.extend({}, rec);

          // deal with primitives
          if( !angular.isObject(data) ) {
            data = {$value: data};
          }

          // remove keys that don't exist anymore
          delete rec.$value;
          each(rec, function(val, key) {
            if( !data.hasOwnProperty(key) ) {
              delete rec[key];
            }
          });

          // apply new values
          angular.extend(rec, data);
          rec.$priority = snap.getPriority();

          return !angular.equals(oldData, rec) ||
            oldData.$value !== rec.$value ||
            oldData.$priority !== rec.$priority;
        }

        function each(obj, iterator, context) {
          angular.forEach(obj, function(v,k) {
            var c = k.charAt(0);
            if( c !== '_' && c !== '$' ) {
              iterator.call(context, v, k, obj);
            }
          });
        }

        /**
         * A utility for converting records to JSON objects
         * which we can save into Firebase. It asserts valid
         * keys and strips off any items prefixed with $.
         *
         * If the rec passed into this method has a toJSON()
         * method, that will be used in place of the custom
         * functionality here.
         *
         * @param rec
         * @returns {*}
         */
        function toJSON(rec) {
          var dat;
          if (angular.isFunction(rec.toJSON)) {
            dat = rec.toJSON();
          }
          else if(rec.hasOwnProperty('$value')) {
            dat = {'.value': rec.$value};
          }
          else {
            dat = {};
            each(rec, function (v, k) {
              dat[k] = v;
            });
          }
          if( rec.hasOwnProperty('$priority') && Object.keys(dat).length > 0 ) {
            dat['.priority'] = rec.$priority;
          }
          angular.forEach(dat, function(v,k) {
            if (k.match(/[.$\[\]#\/]/) && k !== '.value' && k !== '.priority' ) {
              throw new Error('Invalid key ' + k + ' (cannot contain .$[]#)');
            }
            else if( angular.isUndefined(v) ) {
              throw new Error('Key '+k+' was undefined. Cannot pass undefined in JSON. Use null instead.');
            }
          });
          return dat;
        }

        return {
          batch: batch,
          compile: compile,
          updateRec: updateRec,
          assertValidRef: assertValidRef,
          batchDelay: firebaseBatchDelay,
          inherit: inherit,
          getPrototypeMethods: getPrototypeMethods,
          getPublicMethods: getPublicMethods,
          reject: reject,
          defer: defer,
          each: each,
          toJSON: toJSON
        };
      }
    ]);
})();