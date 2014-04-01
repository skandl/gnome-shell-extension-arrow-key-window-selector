/* -*- mode: js2; js2-basic-offset: 4; indent-tabs-mode: nil -*- */

const Clutter = imports.gi.Clutter;
const Lang = imports.lang;

const Lightbox = imports.ui.lightbox;
const Main = imports.ui.main;
const Shell = imports.gi.Shell;
const Tweener = imports.ui.tweener;
const Workspace = imports.ui.workspace;
const WorkspacesView = imports.ui.workspacesView;

/*
 * Helper function for injecting code into existing
 * functions. Taken from other extensions.
 * @param parent: Parent class.
 * @param name: Name of the function.
 * @param func: Function which is to be injected.
 * @return: Return-value of the original or injected function.
 */
function injectToFunction(parent, name, func) {
    let origin = parent[name];
    parent[name] = function() {
        let ret;
        ret = origin.apply(this, arguments);
        if (ret === undefined) {
            ret = func.apply(this, arguments);
        }
        return ret;
    }
}

function init() {
    
}

function enable() {
    
    /*
     * Switches the active workspace. Contribution by Tim Cuthbertson.
     * @param offset: workspace index offset.
     */
    function switchWorkspace(offset) {
        let activeIndex = global.screen.get_active_workspace_index();
        let nextIndex = activeIndex + offset;
        if(nextIndex < 0 || nextIndex >= global.screen.get_n_workspaces()) {
            return;
        }
        let nextWorkspace = global.screen.get_workspace_by_index(nextIndex);
        nextWorkspace.activate(true);
    };

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// WorkspaceView ////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    
    /*
     * Introduces five additional members and registers a 'key-press-event' listener.
     */
    injectToFunction(WorkspacesView.WorkspacesView.prototype, '_init', function(width, height, x, y, workspaces) {
        this._anyKeyPressEventId = global.stage.connect('key-press-event', Lang.bind(this, this._onAnyKeyPress));
        // Index of the window that is - or is to be - selected.
        this._arrowKeyIndex = 0;
        // Navigation memory for making every navigation-step reversible. Otherwise you could navigate into one direction
        // and the next move into the opposite direction would not bring you back to the origin if there was a closer
        // window in that direction. As a side effect navigation rules are cached.
        this._navMemory = [];
        // The currently selected window. Actually it's the window overlay because it 
        // contains the most information and has access to other abstractions.
        this._selected = null;
        this._lightbox = null;
    });
    
    /*
     * Disconnects the 'key-press-event' listener and ends the selection process
     * if it was canceled by the super-key.
     */
    injectToFunction(WorkspacesView.WorkspacesView.prototype, '_onDestroy', function() {
        global.stage.disconnect(this._anyKeyPressEventId);
        this._endSelection(false);
    });
    
    /*
     * Callback function that is triggered by 'key-press-events' and delegates to the 
     * according subroutines.
     * @param actor: Actor which emits the event.
     * @param event: The event object. 
     * @return: Boolean.
     */
    WorkspacesView.WorkspacesView.prototype._onAnyKeyPress = function(actor, event) {
        let key = event.get_key_symbol();
        let state = event.get_state(event);

        if (key == Clutter.Up || key == Clutter.Down || key == Clutter.Left || key == Clutter.Right) {
            return this._arrowKeyPressed(key);
        } else {
            return this._nonArrowKeyPressed(key, state);
        }
    }
    
    /*
     * Entry point for the selection process by arrow keys.
     * @param key: Pressed key.
     * @return: Boolean.
     */
    WorkspacesView.WorkspacesView.prototype._arrowKeyPressed = function(key) {
        let windowOverlays = this.getWindowOverlays();
        let currArrowKeyIndex = this._arrowKeyIndex;
        // Stop immediately if there are no windows or if they need repositioning.
        if (windowOverlays.all().length < 1 || this.getActiveWorkspace().isRepositioning()) {
            return false;
        // If this method has been called before, we already have a selected window.
        } else if (this._selected) {
            this._updateArrowKeyIndex(key, windowOverlays.all());
            if (this._arrowKeyIndex != currArrowKeyIndex) {
                this._selected.unselect(true);
            }
        // Otherwise we have to initialize the selection process.
        } else {
            this._initSelection(windowOverlays.all());
        }
        // Define the new/initially selected window and highlight it.
        if (this._arrowKeyIndex != currArrowKeyIndex || this._selected == null) {
            this._selected = windowOverlays.at(this._arrowKeyIndex);
            this._selected.select(this._lightbox); 
        }
        return true;
    }
    
    /*
     * Activates/closes the currently selected window and/or ends the selection process.
     * @param key: Pressed key.
     * @return: Boolean.
     */
    WorkspacesView.WorkspacesView.prototype._nonArrowKeyPressed = function(key, modifierState) {
        let workspaceIndex = key - Clutter.F1;
        if (this._selected && key == Clutter.Return) {
            let metaWindow = this.getWindowOverlays().at(this._arrowKeyIndex).getMetaWindow();
            this._endSelection(false);
            Main.activateWindow(metaWindow, global.get_current_time());
        } else if (this._selected && key == Clutter.Delete) {
            let windowOverlay = this.getWindowOverlays().at(this._arrowKeyIndex);
            this._endSelection(false);
            windowOverlay.closeWindow();
        } else if(this._selected && workspaceIndex >= 0 && workspaceIndex < global.screen.get_n_workspaces()) {
            let window = this._selected.getMetaWindow();
            this._endSelection(true);
            window.change_workspace_by_index(workspaceIndex, false, global.get_current_time());
        } else {
            this._endSelection(true);
            if(!modifierState) {
                if (key == Clutter.Page_Down) {
                    switchWorkspace(1);
                } else if (key == Clutter.Page_Up) {
                    switchWorkspace(-1);
                }
            }
        }
        return false;
    }

    
    /*
     * Contains all the logic for selecting a new window based on arrow key input.
     * @param key: Pressed key.
     * @param windowOverlays: Window overlays of the active workspace and extra workspaces.
     */
    WorkspacesView.WorkspacesView.prototype._updateArrowKeyIndex = function(key, windowOverlays) {
        // sw ... selected window.
        // cw ... current window.
        let sw = this._selected.getStoredGeometry();
        let currArrowKeyIndex = this._arrowKeyIndex;
        // Just in case some user has infinite resolution...
        let minDistance = Number.POSITIVE_INFINITY;
        // Move up.
        if (key == Clutter.Up) {
            if(this._navMemory[this._arrowKeyIndex][key]) {
                // Retrieve navigation rule.
                this._arrowKeyIndex = this._navMemory[this._arrowKeyIndex][key];
            } else {
                // Find closest window in that direction.
                for (i in windowOverlays) {
                    let cw = windowOverlays[i].getStoredGeometry();
                    let distance = this._calcDistance(sw, cw);
                    if (cw.y + cw.height < sw.y && distance < minDistance) {
                        this._arrowKeyIndex = i;
                        minDistance = distance;
                    }
                } 
            }
            // Store reverse navigation rule.
            if (this._arrowKeyIndex != currArrowKeyIndex) {
                this._navMemory[this._arrowKeyIndex][Clutter.Down] = currArrowKeyIndex;
            }
        // Move down.
        } else if (key == Clutter.Down) {
            if(this._navMemory[this._arrowKeyIndex][key]) {
                this._arrowKeyIndex = this._navMemory[this._arrowKeyIndex][key];
            } else {
                for (i in windowOverlays) {
                    let cw = windowOverlays[i].getStoredGeometry();
                    let distance = this._calcDistance(sw, cw);
                    if (cw.y > sw.y + sw.height && distance < minDistance) {
                        this._arrowKeyIndex = i;
                        minDistance = distance;
                    }
                }
            }
            if (this._arrowKeyIndex != currArrowKeyIndex) {
                this._navMemory[this._arrowKeyIndex][Clutter.Up] = currArrowKeyIndex;
            }
        // Move left.
        } else if (key == Clutter.Left) {
            if(this._navMemory[this._arrowKeyIndex][key]) {
                this._arrowKeyIndex = this._navMemory[this._arrowKeyIndex][key];
            } else {
                for (i in windowOverlays) {
                    let cw = windowOverlays[i].getStoredGeometry();
                    let distance = this._calcDistance(sw, cw);
                    if (cw.x + cw.width < sw.x && distance < minDistance) {
                        this._arrowKeyIndex = i;
                        minDistance = distance;
                    }
                }
            }
            if (this._arrowKeyIndex != currArrowKeyIndex) {
                this._navMemory[this._arrowKeyIndex][Clutter.Right] = currArrowKeyIndex;
            }
        // Move right.
        } else if (key == Clutter.Right) {
            if(this._navMemory[this._arrowKeyIndex][key]) {
                this._arrowKeyIndex = this._navMemory[this._arrowKeyIndex][key];
            } else {
                for (i in windowOverlays) {
                    let cw = windowOverlays[i].getStoredGeometry();
                    let distance = this._calcDistance(sw, cw);
                    if (cw.x > sw.x + sw.width && distance < minDistance) {
                        this._arrowKeyIndex = i;
                        minDistance = distance;
                    }
                }
            }
            if (this._arrowKeyIndex != currArrowKeyIndex) {
                this._navMemory[this._arrowKeyIndex][Clutter.Left] = currArrowKeyIndex;
            }
        }
    }
    
    /*
     * Calculates the Manhattan-Distance of two windows in overview mode. 
     * @param sw: Selected window.
     * @param cw: Currently evaluated window.
     * @return: Number.
     */
    WorkspacesView.WorkspacesView.prototype._calcDistance = function(sw, cw) {
        return Math.abs(sw.center_x - cw.center_x) + Math.abs(sw.center_y - cw.center_y);
    }
    
    /*
     * Adds a lightbox to the main ui group, sets focus to the active window
     * and stores the window geometry of clones. Motion- and button-press-event 
     * listeners assure that the selection process gets terminated if the user wants
     * to do something else.
     * @param windowOverlays: Window overlays of the active workspace and extra workspaces.
     */
    WorkspacesView.WorkspacesView.prototype._initSelection = function(windowOverlays) {
        this._anyButtonPressEventId = global.stage.connect('button-press-event', Lang.bind(this, this._endSelectionForListener));
        this._anyMotionEventId = global.stage.connect('motion-event', Lang.bind(this, this._endSelectionForListener));
        this._lightbox = new Lightbox.Lightbox(Main.uiGroup, {});
        this._lightbox.show();
        let focus = global.screen.get_display().focus_window;
        for (i in windowOverlays) {
            if (windowOverlays[i].getMetaWindow() == focus) {
                this._arrowKeyIndex = i;
            }
            windowOverlays[i].getWindowClone().createGeometrySnapshot();
            this._navMemory[i] = {};
        }
    }
    
    /*
     * Tidy up all actors and adjustments that were introduced during the
     * selection process.
     * @param resetGeometry: Flag which indicates if the geometry of the 
     * selected window should be reset.
     */
    WorkspacesView.WorkspacesView.prototype._endSelection = function(resetGeometry) {
        // As this method is also called each time the WorkpaceView is destroyed,
        // we have to check if a window was selected.
        if (this._selected) {
            global.stage.disconnect(this._anyButtonPressEventId);
            global.stage.disconnect(this._anyMotionEventId);
            this._selected.unselect(resetGeometry);
            this._selected = null;
            this._lightbox.hide();
            this._lightbox.destroy();
            this._lightbox = null;
            this._arrowKeyIndex = 0;
            this._navMemory = [];
        }
    }
    
    /*
     * See WorkspacesView._endSelection. Always resets geometry.
     */
    WorkspacesView.WorkspacesView.prototype._endSelectionForListener = function() {
        this._endSelection(true);
    }
    
    /*
     * Getter for window overlays of the active workspace and surrounding 
     * extra workspaces on different monitors.
     * @return: { all(): [ WindowOverlay ], at(index): WindowOverlay }
     */
    WorkspacesView.WorkspacesView.prototype.getWindowOverlays = function() {
        let windowOverlays = this.getActiveWorkspace().getWindowOverlays();
        for (i in this._extraWorkspaces) {
            let extraWindowOverlays = this._extraWorkspaces[i].getWindowOverlays().all();
            for (j in extraWindowOverlays) {
                windowOverlays.push(extraWindowOverlays[j]);
            }
        }
        return {
            all: function() {
                return windowOverlays.all();
            },
            at: function(index) {
                return windowOverlays.at(index);
            }
        };
    }

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Workspace ////////////////////////////////////////////////////////////////////////////////////////////////////////   
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    
    /*
     * Getter for window overlays of a workspace. After the initial call additional window
     * overlays can be added.
     * @return: { all(): [ WindowOverlay ], at(index): WindowOverlay, push(WindowOverlay): Number }
     */
    Workspace.Workspace.prototype.getWindowOverlays = function() {
        let windowOverlays = this._windowOverlays.slice();
        return {
            all: function() {
                return windowOverlays;
            },
            at: function(index) {
                return windowOverlays[index];
            },
            push: function(windowOverlay) {
                return windowOverlays.push(windowOverlay);
            }
        };
    }
    
    /*
     * Returns true if the workspace is repositioning its windows.
     * @return: Boolean.
     */
    Workspace.Workspace.prototype.isRepositioning = function() {
        return this._repositionWindowsId != 0;
    }
    
///////////////////////////////////////////////////////////////////////////////////////////////////////////////////// 
// WindowClone //////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    
    /*
     * Introduces a dictionary for window geometry and registers a key-press-event listener 
     * for terminating the scroll-zooming process when you want to start selecting.
     */
    injectToFunction(Workspace.WindowClone.prototype, '_init', function(realWindow) {
        this._anyKeyPressEventId = global.stage.connect('key-press-event', Lang.bind(this, function() {
            if (this._zooming) {
                this._zoomEnd();
            }
        }));
        this.storedGeometry = {};
    });
    
    /*
     * Disconnects the key-press-event listener.
     */
    injectToFunction(Workspace.WindowClone.prototype, '_onDestroy', function() {
        global.stage.disconnect(this._anyKeyPressEventId);
    });
    
    /*
     * Highlights and zooms the currently selected window.
     * @param lightbox: A reference to the lightbox introduced by WorkspacesView._initSelection.
     * @param windowCount: Number of windows on the active workspace.
     */
    Workspace.WindowClone.prototype.select = function(lightbox) {
        // Store the original parent and highlight the window.
        this._origParent = this.actor.get_parent();
        this.actor.reparent(Main.uiGroup);
        this.actor.raise_top();
        lightbox.highlight(this.actor);
        // Define the available area.
        let monitorIndex = this.metaWindow.get_monitor();
        let availArea = Main.layoutManager.monitors[monitorIndex];
        let padding = 30;
        let limitTop = availArea.y + padding;
        let limitBottom = availArea.y + availArea.height - padding;
        let limitLeft = availArea.x + padding;
        let limitRight = availArea.x + availArea.width - padding;
        let limitWidth = limitRight - limitLeft;
        let limitHeight = limitBottom - limitTop;
        // Calculate the desired new dimension.
        let factor = 1.3;
        let newScaleX = this.actor.scale_x * factor;
        let newScaleY = this.actor.scale_y * factor;
        let newWidth = this.actor.width * newScaleX;
        let newHeight = this.actor.height * newScaleY;
        // Adjust the dimension to the available area.
        while (newWidth > limitWidth || newHeight > limitHeight || 
               newScaleX > 1.0 || newScaleY > 1.0) {
            factor -= 0.1;
            newScaleX = this.actor.scale_x * factor;
            newScaleY = this.actor.scale_y * factor;
            newWidth = this.actor.width * newScaleX;
            newHeight = this.actor.height * newScaleY;
        }
        // Calculate the desired new position.
        let deltaWidth =  newWidth - this.actor.width * this.actor.scale_x;
        let deltaHeight = newHeight - this.actor.height * this.actor.scale_y;
        let newX = this.actor.x - deltaWidth / 2;
        let newY = this.actor.y - deltaHeight / 2;
        // Adjust the new position to the available area.
        if (monitorIndex == Main.layoutManager.primaryIndex) limitTop += Main.panel.actor.height;
        if (newX + newWidth > limitRight) newX = limitRight - newWidth;
        if (newX < limitLeft) newX = limitLeft;
        if (newY + newHeight > limitBottom) newY = limitBottom - newHeight;
        if (newY < limitTop) newY = limitTop;
        // Zoom the window.
        Tweener.addTween(this.actor, { 
            x: newX,
            y: newY,
            scale_x: newScaleX,
            scale_y: newScaleY,
            time: 0.2,
            transition: 'easeOutQuad' 
        });
    }
    
    /*
     * Undoes the adjustments done by WindowClone.select.
     * @param resetGeometry: Flag which indicates if the geometry 
     * should be reset.
     */
    Workspace.WindowClone.prototype.unselect = function(resetGeometry) {
        Tweener.removeTweens(this.actor);
        this.actor.reparent(this._origParent);
        if (this._stackAbove == null) {
            this.actor.lower_bottom();
        } else if (this._stackAbove.get_parent()) {
            this.actor.raise(this._stackAbove);
        }
        if (resetGeometry) {
            this.actor.x = this.storedGeometry.x; 
            this.actor.y = this.storedGeometry.y;
            this.actor.scale_x = this.storedGeometry.scale_x;
            this.actor.scale_y = this.storedGeometry.scale_y; 
        }
    }
    
    /*
     * Creates a snapshot of the window geometry.
     */
    Workspace.WindowClone.prototype.createGeometrySnapshot = function() {
        let width = this.actor.width * this.actor.scale_x;
        let height = this.actor.height * this.actor.scale_y;
        this.storedGeometry = {
            x: this.actor.x, 
            y: this.actor.y,
            width: width,
            height: height, 
            scale_x: this.actor.scale_x,
            scale_y: this.actor.scale_y,
            center_x: this.actor.x + width / 2,
            center_y: this.actor.y + height / 2
        };
    }
    
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////   
// WindowOverlay ////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    /*
     * Selects the associated window. See WindowClone.select.
     * @param lightbox: A reference to the lightbox introduced by WorkspacesView._initSelection.
     * @param windowCount: Number of windows on the active workspace.
     */
    Workspace.WindowOverlay.prototype.select = function(lightbox, windowCount) {
        this.hide();
        this._windowClone.select(lightbox, windowCount);
    }
    
    /*
     * Unselects the associated window. See WindowClone.unselect.
     * @param resetGeometry: Flag which indicates if the geometry 
     * should be reset.
     */
    Workspace.WindowOverlay.prototype.unselect = function(resetGeometry) {
        this.show();
        this._windowClone.unselect(resetGeometry);
    }
    
    /*
     * Closes the associated window.
     */
    Workspace.WindowOverlay.prototype.closeWindow = function() {
        this._closeWindow(null);
    }
    
    /*
     * Returns a geometry-info object of the window clone.
     * @return: Object.
     */
    Workspace.WindowOverlay.prototype.getStoredGeometry = function() {
        return this._windowClone.storedGeometry;
    }
    
    /*
     * Getter for the window clone.
     * @return: WindowClone.
     */
    Workspace.WindowOverlay.prototype.getWindowClone = function() {
        return this._windowClone;
    }
    
    /*
     * Getter for the meta window.
     * @return: MetaWindow.
     */
    Workspace.WindowOverlay.prototype.getMetaWindow = function() {
        return this._windowClone.metaWindow;
    }
    
    log('Arrow Key Window Selector enabled');
}


function disable() {
    log('Arrow Key Window Selector disabled');
}

